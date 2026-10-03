import { MS, redisKeys, sha256Hex } from '@bastion-mcp/core';
import { z } from 'zod';
import { type Clock, type Logger, noopLogger, type RedisLike, systemClock } from '../ports';
import { LIST_METHODS } from './kinds';

/**
 * Upstream list cache (6.7): per `(installationId, credentialHash)` in a per-worker LRU (10,000 entries) and in Redis
 * `lc:{installationId}:{credentialHash}:{method}`, for the upstream's `ttlMs` when present, else
 * `BASTION_LIST_CACHE_TTL_MS` (default 300,000). Invalidation deletes both.
 */

export * from './kinds';

export const LRU_ENTRIES = 10_000;
export const DEFAULT_LIST_CACHE_TTL_MS = 5 * MS.MINUTE;

export type CachedList = {
  items: unknown[];
  /** The upstream's `ttlMs`, when it sent one. */
  ttlMs?: number | undefined;
  instructions?: string | undefined;
  serverInfo?: { name: string; version: string; title?: string | undefined } | undefined;
};

const cachedSchema = z.object({
  items: z.array(z.unknown()),
  ttlMs: z.number().optional(),
  instructions: z.string().optional(),
  serverInfo: z
    .object({ name: z.string(), version: z.string(), title: z.string().optional() })
    .optional(),
});

type Slot = { value: CachedList; expiresAt: number };

/** A small LRU keyed by string; `Map` keeps insertion order, so re-inserting on access makes the first key the oldest. */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

export type ListCacheOptions = {
  redis: RedisLike;
  maxEntries?: number;
  defaultTtlMs?: number;
  clock?: Clock;
  logger?: Logger;
};

export class ListCache {
  private readonly lru: Lru<Slot>;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly defaultTtlMs: number;
  /** Credential hashes this worker has cached per installation, for invalidation by installation alone. */
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly options: ListCacheOptions) {
    this.lru = new Lru(options.maxEntries ?? LRU_ENTRIES);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_LIST_CACHE_TTL_MS;
  }

  get size(): number {
    return this.lru.size;
  }

  /** TTL in ms for a result: the upstream's `ttlMs` when present, else the configured default (6.7). */
  ttlFor(upstreamTtlMs: number | undefined): number {
    return upstreamTtlMs ?? this.defaultTtlMs;
  }

  async get(
    installationId: string,
    credentialHash: string,
    method: string,
  ): Promise<CachedList | null> {
    const key = redisKeys.listCache(installationId, credentialHash, method);
    const hit = this.lru.get(key);
    if (hit) {
      if (hit.expiresAt > this.clock.now()) return hit.value;
      this.lru.delete(key);
    }
    let raw: string | null;
    try {
      raw = await this.options.redis.get(key);
    } catch (error) {
      this.logger.warn('list cache read failed', { error: String(error) });
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = cachedSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      const value: CachedList = {
        items: parsed.data.items,
        ttlMs: parsed.data.ttlMs,
        instructions: parsed.data.instructions,
        serverInfo: parsed.data.serverInfo,
      };
      // The Redis TTL is the freshness bound; the LRU copy lives at most as long as the default or upstream ttl.
      this.lru.set(key, { value, expiresAt: this.clock.now() + this.ttlFor(value.ttlMs) });
      return value;
    } catch {
      return null;
    }
  }

  async put(
    installationId: string,
    credentialHash: string,
    method: string,
    value: CachedList,
  ): Promise<void> {
    const ttl = this.ttlFor(value.ttlMs);
    if (ttl <= 0) return; // the upstream said "do not cache"
    const key = redisKeys.listCache(installationId, credentialHash, method);
    this.lru.set(key, { value, expiresAt: this.clock.now() + ttl });
    const hashes = this.seen.get(installationId) ?? new Set<string>();
    hashes.add(credentialHash);
    this.seen.set(installationId, hashes);
    try {
      await this.options.redis.set(key, JSON.stringify(value), 'PX', ttl);
    } catch (error) {
      this.logger.warn('list cache write failed', { error: String(error) });
    }
  }

  /** Deletes the LRU entries and the Redis keys (6.7). Without a credential hash, every hash this worker saw. */
  async invalidate(installationId: string, credentialHash?: string): Promise<void> {
    const hashes =
      credentialHash === undefined ? [...(this.seen.get(installationId) ?? [])] : [credentialHash];
    const keys: string[] = [];
    for (const hash of hashes) {
      for (const method of LIST_METHODS)
        keys.push(redisKeys.listCache(installationId, hash, method));
    }
    for (const key of this.lru.keys()) {
      if (
        key.startsWith(`lc:${installationId}:`) &&
        (credentialHash === undefined || keys.includes(key))
      ) {
        this.lru.delete(key);
      }
    }
    for (const key of keys) this.lru.delete(key);
    if (keys.length > 0) await this.options.redis.del(...keys).catch(() => 0);
    if (credentialHash === undefined) this.seen.delete(installationId);
  }
}

/** `resources/read` results are cached only when the upstream returns `ttlMs > 0` and `cacheScope: "public"` (6.7). */
export class ReadCache {
  private readonly lru: Lru<{ result: unknown; expiresAt: number }>;
  private readonly clock: Clock;

  constructor(
    private readonly redis: RedisLike,
    options: { maxEntries?: number; clock?: Clock } = {},
  ) {
    this.lru = new Lru(options.maxEntries ?? LRU_ENTRIES);
    this.clock = options.clock ?? systemClock;
  }

  private key(installationId: string, uri: string): string {
    return `rc:${installationId}:${sha256Hex(uri)}`;
  }

  static cacheable(result: unknown): number | undefined {
    if (typeof result !== 'object' || result === null) return undefined;
    const { ttlMs, cacheScope } = result as { ttlMs?: unknown; cacheScope?: unknown };
    return typeof ttlMs === 'number' && ttlMs > 0 && cacheScope === 'public' ? ttlMs : undefined;
  }

  async get(installationId: string, uri: string): Promise<unknown | undefined> {
    const key = this.key(installationId, uri);
    const hit = this.lru.get(key);
    if (hit && hit.expiresAt > this.clock.now()) return hit.result;
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  async put(installationId: string, uri: string, result: unknown): Promise<boolean> {
    const ttl = ReadCache.cacheable(result);
    if (ttl === undefined) return false;
    const key = this.key(installationId, uri);
    this.lru.set(key, { result, expiresAt: this.clock.now() + ttl });
    await this.redis.set(key, JSON.stringify(result), 'PX', ttl).catch(() => null);
    return true;
  }
}

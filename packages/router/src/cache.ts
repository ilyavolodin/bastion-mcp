/** Per-worker cache of compiled endpoints (4.3): LRU, 60 s TTL, event invalidation, single flight. */
import { TTL } from '@bastion-mcp/core';
import type { EffectiveEndpoint } from './types';

export type EndpointCacheKey = { principalId: string; endpointId: string; configVersion: string };

/** A `bastion:config` or `bastion:notify` event (4.3). */
export type ConfigEvent = {
  scope: 'org' | 'user' | 'team' | 'installation' | 'catalog' | 'endpoint' | string;
  id: string;
  version?: string | number | undefined;
};

export type EndpointCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  /** `bastion.config.compile.duration` in seconds (15.3). */
  onCompile?: (durationSeconds: number) => void;
};

type Slot = { endpoint: EffectiveEndpoint; expiresAt: number };

const keyOf = (k: EndpointCacheKey): string =>
  `${k.principalId}\0${k.endpointId}\0${k.configVersion}`;

const matches = (endpoint: EffectiveEndpoint, event: ConfigEvent): boolean => {
  const d = endpoint.dependencies;
  switch (event.scope) {
    case 'org':
      return true;
    case 'user':
      return endpoint.principalId === event.id;
    case 'endpoint':
      return endpoint.endpointId === event.id;
    case 'installation':
      return d.installationIds.includes(event.id);
    case 'catalog':
      return d.catalogEntryIds.includes(event.id);
    case 'team':
      return d.teamIds.includes(event.id);
    default:
      // Unknown scope: dropping is always safe.
      return true;
  }
};

export class EndpointCache {
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<EffectiveEndpoint>>();
  private generation = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onCompile: ((seconds: number) => void) | undefined;

  constructor(options: EndpointCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? TTL.configCache * 1000;
    this.now = options.now ?? (() => Date.now());
    this.onCompile = options.onCompile;
  }

  get size(): number {
    return this.slots.size;
  }

  get(key: EndpointCacheKey): EffectiveEndpoint | undefined {
    const k = keyOf(key);
    const slot = this.slots.get(k);
    if (!slot) return undefined;
    if (slot.expiresAt <= this.now()) {
      this.slots.delete(k);
      return undefined;
    }
    this.slots.delete(k);
    this.slots.set(k, slot);
    return slot.endpoint;
  }

  /** Returns the cached endpoint or compiles it once for all concurrent callers. */
  getOrCompile(
    key: EndpointCacheKey,
    compile: () => Promise<EffectiveEndpoint>,
  ): Promise<EffectiveEndpoint> {
    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);
    const k = keyOf(key);
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const generation = this.generation;
    const started = performance.now();
    const run = (async () => {
      try {
        const endpoint = await compile();
        this.onCompile?.((performance.now() - started) / 1000);
        // An invalidation that arrived during compilation may have made this result stale.
        if (generation === this.generation) this.set(k, endpoint);
        return endpoint;
      } finally {
        this.inflight.delete(k);
      }
    })();
    this.inflight.set(k, run);
    return run;
  }

  private set(k: string, endpoint: EffectiveEndpoint): void {
    this.slots.delete(k);
    this.slots.set(k, { endpoint, expiresAt: this.now() + this.ttlMs });
    while (this.slots.size > this.maxEntries) {
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
  }

  /** Drops entries touched by the event; returns how many were dropped. */
  invalidate(event: ConfigEvent): number {
    this.generation += 1;
    let dropped = 0;
    for (const [k, slot] of this.slots) {
      if (!matches(slot.endpoint, event)) continue;
      if (
        event.version !== undefined &&
        Number(slot.endpoint.configVersion) > Number(event.version)
      ) {
        continue;
      }
      this.slots.delete(k);
      dropped += 1;
    }
    return dropped;
  }

  clear(): void {
    this.generation += 1;
    this.slots.clear();
  }
}

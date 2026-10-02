import { sha256Hex } from '@bastion-mcp/core';
import { type Clock, type KmsProvider, systemClock } from './types';

export const DEK_CACHE_TTL_MS = 15 * 60 * 1000;
export const DEK_CACHE_MAX_KEYS = 1000;

type Entry = { dek: Buffer; expiresAt: number };

/**
 * 21.3: unwrapped DEKs live in memory for 15 minutes (LRU, 1,000 keys) so running work survives a
 * KMS outage. Entries are keyed by a hash of (kekRef, wrapped DEK); a Map preserves recency order.
 */
export class CachingKmsProvider implements KmsProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly clock: Clock;

  constructor(
    private readonly inner: KmsProvider,
    options: { ttlMs?: number; maxKeys?: number; clock?: Clock } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEK_CACHE_TTL_MS;
    this.maxKeys = options.maxKeys ?? DEK_CACHE_MAX_KEYS;
    this.clock = options.clock ?? systemClock;
  }

  get kekRef(): string {
    return this.inner.kekRef;
  }

  get size(): number {
    return this.entries.size;
  }

  wrap(dek: Buffer, signal?: AbortSignal): Promise<Buffer> {
    return this.inner.wrap(dek, signal);
  }

  health(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.health(signal);
  }

  async unwrap(wrapped: Buffer, kekRef: string, signal?: AbortSignal): Promise<Buffer> {
    const id = sha256Hex(`${kekRef}|${wrapped.toString('base64')}`);
    const now = this.clock.now();
    const hit = this.entries.get(id);
    if (hit && hit.expiresAt > now) {
      // Refresh recency: re-insert at the end of the Map.
      this.entries.delete(id);
      this.entries.set(id, hit);
      return Buffer.from(hit.dek);
    }
    this.entries.delete(id);
    const dek = await this.inner.unwrap(wrapped, kekRef, signal);
    this.entries.set(id, { dek: Buffer.from(dek), expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return dek;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.dek.fill(0);
    this.entries.clear();
  }
}

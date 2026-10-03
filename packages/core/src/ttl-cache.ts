import type { Clock } from './clock';
import { systemClock } from './clock';

export interface TtlCacheOptions {
  ttlMs: number;
  /** Entry cap; the oldest entry is evicted first. Defaults to unbounded. */
  max?: number;
  clock?: Clock;
}

/** Small bounded cache whose entries expire `ttlMs` after being set. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly clock: Clock;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.max = options.max ?? Number.POSITIVE_INFINITY;
    this.clock = options.clock ?? systemClock;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

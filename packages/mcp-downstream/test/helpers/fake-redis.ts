import type { DownstreamRedis, RedisSubscriber } from '../../src/ports';

type Entry =
  | { kind: 'string'; value: string; expiresAt?: number | undefined }
  | { kind: 'hash'; value: Map<string, string>; expiresAt?: number | undefined }
  | { kind: 'zset'; value: Map<string, number>; expiresAt?: number | undefined };

/**
 * In-memory stand-in for the `ioredis` subset of `DownstreamRedis`, with TTLs on a controllable clock and
 * synchronous pub/sub that connects every `duplicate()` subscriber of the same instance.
 */
export class FakeRedis implements DownstreamRedis {
  private readonly data = new Map<string, Entry>();
  private readonly subscribers = new Set<FakeSubscriber>();
  /** Milliseconds; tests advance it to expire keys. */
  now = 0;
  readonly published: { channel: string; message: string }[] = [];
  /** Makes every command reject, to test Redis outages. */
  failing = false;

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private check(): void {
    if (this.failing) throw new Error('redis down');
  }

  keys(): string[] {
    return [...this.data.keys()].filter((k) => this.live(k) !== undefined);
  }

  ttlSeconds(key: string): number | undefined {
    const entry = this.live(key);
    if (!entry || entry.expiresAt === undefined) return undefined;
    return Math.ceil((entry.expiresAt - this.now) / 1000);
  }

  async get(key: string): Promise<string | null> {
    this.check();
    const entry = this.live(key);
    return entry?.kind === 'string' ? entry.value : null;
  }

  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    this.check();
    this.data.set(key, { kind: 'string', value, expiresAt: this.now + seconds * 1000 });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.check();
    let n = 0;
    for (const key of keys) if (this.live(key) && this.data.delete(key)) n += 1;
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.check();
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = this.now + seconds * 1000;
    return 1;
  }

  async hset(key: string, data: Record<string, string>): Promise<number> {
    this.check();
    const existing = this.live(key);
    const hash = existing?.kind === 'hash' ? existing : { kind: 'hash' as const, value: new Map() };
    for (const [k, v] of Object.entries(data)) hash.value.set(k, v);
    this.data.set(key, hash);
    return Object.keys(data).length;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.check();
    const entry = this.live(key);
    return entry?.kind === 'hash' ? Object.fromEntries(entry.value) : {};
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.check();
    const entry = this.live(key);
    return entry?.kind === 'hash' ? (entry.value.get(field) ?? null) : null;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.check();
    const existing = this.live(key);
    const zset = existing?.kind === 'zset' ? existing : { kind: 'zset' as const, value: new Map() };
    const added = zset.value.has(member) ? 0 : 1;
    zset.value.set(member, score);
    this.data.set(key, zset);
    return added;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    this.check();
    const entry = this.live(key);
    if (entry?.kind !== 'zset') return 0;
    let n = 0;
    for (const m of members) if (entry.value.delete(m)) n += 1;
    return n;
  }

  async zcard(key: string): Promise<number> {
    this.check();
    const entry = this.live(key);
    return entry?.kind === 'zset' ? entry.value.size : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    this.check();
    const entry = this.live(key);
    if (entry?.kind !== 'zset') return [];
    const sorted = [...entry.value.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map(([m]) => m);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end);
  }

  async publish(channel: string, message: string): Promise<number> {
    this.check();
    this.published.push({ channel, message });
    let n = 0;
    for (const sub of this.subscribers) n += sub.deliver(channel, message);
    return n;
  }

  duplicate(): RedisSubscriber {
    const sub = new FakeSubscriber(this.subscribers);
    this.subscribers.add(sub);
    return sub;
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  channelSubscriptions(channel: string): number {
    let n = 0;
    for (const sub of this.subscribers) if (sub.channels.has(channel)) n += 1;
    return n;
  }
}

class FakeSubscriber implements RedisSubscriber {
  readonly channels = new Set<string>();
  private readonly listeners: ((channel: string, message: string) => void)[] = [];

  constructor(private readonly registry: Set<FakeSubscriber>) {}

  async subscribe(...channels: string[]): Promise<unknown> {
    for (const c of channels) this.channels.add(c);
    return channels.length;
  }

  async unsubscribe(...channels: string[]): Promise<unknown> {
    for (const c of channels) this.channels.delete(c);
    return 0;
  }

  on(_event: 'message', listener: (channel: string, message: string) => void): unknown {
    this.listeners.push(listener);
    return this;
  }

  async quit(): Promise<unknown> {
    this.registry.delete(this);
    this.channels.clear();
    return 'OK';
  }

  deliver(channel: string, message: string): number {
    if (!this.channels.has(channel)) return 0;
    for (const l of this.listeners) l(channel, message);
    return 1;
  }
}

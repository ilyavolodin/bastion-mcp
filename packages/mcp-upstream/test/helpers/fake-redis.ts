import { COMPARE_AND_DELETE, COMPARE_AND_PEXPIRE, DECR_FLOOR } from '../../src/ownership/lua';
import type { RedisLike } from '../../src/ports';

type Entry = { value: string; expiresAt: number | undefined };

/** In-memory `RedisLike`, including the three Lua scripts of the package. `failing` simulates an outage. */
export class FakeRedis implements RedisLike {
  failing = false;
  readonly strings = new Map<string, Entry>();
  readonly hashes = new Map<string, { fields: Record<string, string>; expiresAt: number | undefined }>();
  readonly published: { channel: string; message: string }[] = [];
  now = (): number => Date.now();

  private guard(): void {
    if (this.failing) throw new Error('ECONNREFUSED');
  }

  private live(key: string): Entry | undefined {
    const entry = this.strings.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  private liveHash(key: string) {
    const entry = this.hashes.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...options: (string | number)[]): Promise<'OK' | null> {
    this.guard();
    let nx = false;
    let ttl: number | undefined;
    for (let i = 0; i < options.length; i += 1) {
      const token = String(options[i]).toUpperCase();
      if (token === 'NX') nx = true;
      else if (token === 'PX') ttl = Number(options[(i += 1)]);
      else if (token === 'EX') ttl = Number(options[(i += 1)]) * 1000;
    }
    if (nx && this.live(key)) return null;
    this.strings.set(key, { value, expiresAt: ttl === undefined ? undefined : this.now() + ttl });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.guard();
    let n = 0;
    for (const key of keys) {
      if (this.live(key)) n += 1;
      else if (this.liveHash(key)) n += 1;
      this.strings.delete(key);
      this.hashes.delete(key);
    }
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.pexpire(key, seconds * 1000);
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.guard();
    const entry = this.live(key);
    if (entry) {
      entry.expiresAt = this.now() + ms;
      return 1;
    }
    const hash = this.liveHash(key);
    if (hash) {
      hash.expiresAt = this.now() + ms;
      return 1;
    }
    return 0;
  }

  async hset(key: string, data: Record<string, string>): Promise<number> {
    this.guard();
    const entry = this.liveHash(key) ?? { fields: {}, expiresAt: undefined };
    Object.assign(entry.fields, data);
    this.hashes.set(key, entry);
    return Object.keys(data).length;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.guard();
    return { ...(this.liveHash(key)?.fields ?? {}) };
  }

  async incrby(key: string, increment: number): Promise<number> {
    this.guard();
    const next = Number(this.live(key)?.value ?? 0) + increment;
    const entry = this.live(key);
    this.strings.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  decr(key: string): Promise<number> {
    return this.incrby(key, -1);
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.guard();
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    const key = keys[0] as string;
    if (script === COMPARE_AND_DELETE) {
      return this.live(key)?.value === argv[0] ? this.del(key) : 0;
    }
    if (script === COMPARE_AND_PEXPIRE) {
      return this.live(key)?.value === argv[0] ? this.pexpire(key, Number(argv[1])) : 0;
    }
    if (script === DECR_FLOOR) {
      const value = await this.decr(key);
      if (value < 0) {
        await this.set(key, '0');
        return 0;
      }
      return value;
    }
    throw new Error('FakeRedis: unknown script');
  }

  async publish(channel: string, message: string): Promise<number> {
    this.guard();
    this.published.push({ channel, message });
    return 1;
  }
}

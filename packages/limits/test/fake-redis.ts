import type { RedisLike, RedisMulti } from '../src/types';

type Entry = { value: number; expiresAt: number };

/** In-memory stand-in for the Redis commands the limiter uses; `failing` simulates an outage. */
export class FakeRedis implements RedisLike {
  failing = false;
  /** Commands never answer, like a half-open connection. */
  hanging = false;
  readonly counters = new Map<string, Entry>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly defined: string[] = [];
  bastionAcquire?: RedisLike['bastionAcquire'];
  rlflxIncr?: (args: string[]) => Promise<[number, number]>;

  private guard(): void {
    if (this.failing) throw new Error('ECONNREFUSED');
  }

  private live(key: string): Entry | undefined {
    const e = this.counters.get(key);
    if (e && e.expiresAt <= Date.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return e;
  }

  defineCommand(name: string, _definition: { numberOfKeys: number; lua: string }): void {
    this.defined.push(name);
    if (name === 'rlflxIncr') {
      this.rlflxIncr = async (args) => {
        this.guard();
        if (this.hanging) return new Promise<[number, number]>(() => undefined);
        const [key = '', points = '0', seconds = '0'] = args;
        const entry = this.live(key) ?? {
          value: 0,
          expiresAt: Date.now() + Number(seconds) * 1000,
        };
        entry.value += Number(points);
        this.counters.set(key, entry);
        return [entry.value, entry.expiresAt - Date.now()];
      };
    }
    if (name === 'bastionAcquire') {
      this.bastionAcquire = async (key, nowMs, expiresMs, max, member) => {
        this.guard();
        let set = this.zsets.get(key);
        if (!set) {
          set = new Map();
          this.zsets.set(key, set);
        }
        for (const [m, score] of set) if (score <= nowMs) set.delete(m);
        if (set.size >= max) return [0, set.size];
        set.set(member, expiresMs);
        return [1, set.size];
      };
    }
  }

  multi(): RedisMulti {
    const keys: string[] = [];
    const chain: RedisMulti = {
      get: (key) => {
        keys.push(key);
        return chain;
      },
      pttl: () => chain,
      exec: async () => {
        this.guard();
        const key = keys[0] ?? '';
        const e = this.live(key);
        return [
          [null, e ? String(e.value) : null],
          [null, e ? e.expiresAt - Date.now() : -2],
        ];
      },
    };
    return chain;
  }

  async zrem(key: string, member: string): Promise<number> {
    this.guard();
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async zcount(key: string, min: string | number, _max: string | number): Promise<number> {
    this.guard();
    const floor = Number(String(min).replace('(', ''));
    return [...(this.zsets.get(key)?.values() ?? [])].filter((s) => s > floor).length;
  }
}

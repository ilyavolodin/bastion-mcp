import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RULE,
  blockedFor,
  clearFailures,
  IP_RULE,
  loginBlockedFor,
  recordFailure,
  recordLoginFailure,
} from '../src/http/ui/throttle';
import { fakeInfra } from './fake-infra';

/** Just the Redis commands the throttle uses, with a TTL that does not tick. */
const fakeRedis = () => {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counters,
    ttls,
    get: async (key: string) => (counters.has(key) ? String(counters.get(key)) : null),
    ttl: async (key: string) => ttls.get(key) ?? -1,
    incr: async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    },
    del: async (key: string) => (counters.delete(key) ? 1 : 0),
  };
};

describe('22.3 login throttle', () => {
  it('does not block before the limit and blocks at it, reporting the remaining window', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    for (let i = 0; i < IP_RULE.max - 1; i += 1) await recordFailure(infra, IP_RULE, '1.2.3.4');
    expect(await blockedFor(infra, IP_RULE, '1.2.3.4')).toBe(0);
    await recordFailure(infra, IP_RULE, '1.2.3.4');
    expect(await blockedFor(infra, IP_RULE, '1.2.3.4')).toBe(IP_RULE.windowSeconds);
  });

  it('starts the window at the first failure only', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    await recordFailure(infra, ACCOUNT_RULE, 'a@x');
    redis.ttls.set([...redis.counters.keys()][0] ?? '', 10);
    await recordFailure(infra, ACCOUNT_RULE, 'a@x');
    expect([...redis.ttls.values()]).toEqual([10]);
  });

  it('reports the live ttl once blocked', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    for (let i = 0; i < ACCOUNT_RULE.max; i += 1) await recordFailure(infra, ACCOUNT_RULE, 'a@x');
    redis.ttls.set([...redis.counters.keys()][0] ?? '', 42);
    expect(await blockedFor(infra, ACCOUNT_RULE, 'a@x')).toBe(42);
  });

  it('hashes account subjects and keeps addresses readable', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    await recordFailure(infra, IP_RULE, '10.0.0.1');
    await recordFailure(infra, ACCOUNT_RULE, 'someone@example.com');
    const keys = [...redis.counters.keys()];
    expect(keys[0]).toBe('rl:login:ip:10.0.0.1');
    expect(keys[1]).toMatch(/^rl:login:account:[0-9a-f]{32}$/);
    expect(keys[1]).not.toContain('example');
  });

  it('clears a counter', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    for (let i = 0; i < ACCOUNT_RULE.max; i += 1) await recordFailure(infra, ACCOUNT_RULE, 'a@x');
    await clearFailures(infra, ACCOUNT_RULE, 'a@x');
    expect(await blockedFor(infra, ACCOUNT_RULE, 'a@x')).toBe(0);
  });

  it('takes the longest wait over the address and account rules', async () => {
    const redis = fakeRedis();
    const infra = fakeInfra({ redis });
    for (let i = 0; i < ACCOUNT_RULE.max; i += 1) await recordLoginFailure(infra, '9.9.9.9', 'a@x');
    expect(await loginBlockedFor(infra, '9.9.9.9', 'a@x')).toBe(ACCOUNT_RULE.windowSeconds);
    expect(await loginBlockedFor(infra, '8.8.8.8', 'other@x')).toBe(0);
  });
});

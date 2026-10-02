import { QuotaExceededError, RateLimitedError } from '@bastion-mcp/core';
import { dockerAvailable, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLimiter,
  createRedisLimiter,
  type OperationContext,
  parseRule,
  type RedisLike,
  type Rule,
  secondsToPeriodEnd,
} from '../src';

const connect = async (url: string): Promise<Redis> => {
  const c = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  c.on('error', () => undefined);
  if (c.status !== 'ready') await new Promise<void>((resolve) => c.once('ready', () => resolve()));
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dockerAvailable())('14.2 limits against real Redis (Valkey 8)', () => {
  let server: TestRedis;
  let client: Redis;
  let n = 0;

  beforeAll(async () => {
    server = await startRedis();
    client = await connect(server.url);
  }, 120_000);

  afterAll(async () => {
    client.disconnect();
    await server.stop();
  });

  // ioredis must satisfy the RedisLike port.
  const asPort = (): RedisLike => client;
  const op = (userId: string): OperationContext => ({
    principal: { orgId: 'o', userId },
    method: 'tools/call',
    toolName: 'x__y',
  });
  const uniqueUser = () => `user-${++n}-${Date.now()}`;
  const rule = (over: Record<string, unknown>): Rule =>
    parseRule({ id: `rule-${++n}`, name: 'Rule', subject: 'user', ...over });

  it('14.2 semaphore: caps in-flight calls, releases with ZREM', async () => {
    const limiter = createRedisLimiter({ redis: asPort() });
    const r = rule({ kind: 'concurrency', params: { max: 2, leaseSeconds: 900 } });
    const u = uniqueUser();
    const a = await limiter.check(op(u), [r], 'a');
    await limiter.check(op(u), [r], 'b');
    await expect(limiter.check(op(u), [r], 'c')).rejects.toThrow(RateLimitedError);
    expect((await limiter.readUsage(r, u)).consumed).toBe(2);
    await a.release();
    expect((await limiter.readUsage(r, u)).consumed).toBe(1);
    await expect(limiter.check(op(u), [r], 'd')).resolves.toBeDefined();
  });

  it('14.2 semaphore: leases expire on their own after leaseSeconds', async () => {
    const limiter = createRedisLimiter({ redis: asPort() });
    const r = rule({ kind: 'concurrency', params: { max: 1, leaseSeconds: 1 } });
    const u = uniqueUser();
    await limiter.check(op(u), [r], 'dead-worker');
    await expect(limiter.check(op(u), [r], 'b')).rejects.toThrow(RateLimitedError);
    await sleep(1300);
    expect((await limiter.readUsage(r, u)).consumed).toBe(0);
    await expect(limiter.check(op(u), [r], 'c')).resolves.toBeDefined();
  });

  it('14.2 semaphore: concurrent acquires never exceed max (Lua is atomic)', async () => {
    const limiter = createRedisLimiter({ redis: asPort() });
    const r = rule({ kind: 'concurrency', params: { max: 5, leaseSeconds: 900 } });
    const u = uniqueUser();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => limiter.check(op(u), [r], `req-${i}`)),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
  });

  it('14.2 rate: sustained rate plus burst allowance, then RATE_LIMITED with retryAfterMs', async () => {
    const limiter = createRedisLimiter({ redis: asPort() });
    const r = rule({ kind: 'rate', params: { points: 5, perSeconds: 60, burst: 3 } });
    const u = uniqueUser();
    for (let i = 0; i < 8; i++) await limiter.check(op(u), [r], `r${i}`);
    const err = await limiter.check(op(u), [r], 'over').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    const { retryAfterMs } = (err as RateLimitedError).data as { retryAfterMs: number };
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(60_000);
    expect((await limiter.readUsage(r, u)).consumed).toBe(5);
  });

  it('14.2 rate: one rule keeps separate counters per subject', async () => {
    const limiter = createRedisLimiter({ redis: asPort() });
    const r = rule({ kind: 'rate', params: { points: 1, perSeconds: 60, burst: 0 } });
    await limiter.check(op(uniqueUser()), [r], 'a');
    await expect(limiter.check(op(uniqueUser()), [r], 'b')).resolves.toBeDefined();
  });

  it('14.2 quota: period key, TTL of seconds-to-end plus a day, exhaustion and refund', async () => {
    const limiter = createRedisLimiter({ redis: asPort(), timeZone: 'UTC' });
    const r = rule({ kind: 'quota', params: { points: 2, period: 'month' } });
    const u = uniqueUser();
    const first = await limiter.check(op(u), [r], 'a');
    await limiter.check(op(u), [r], 'b');
    const err = await limiter.check(op(u), [r], 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);

    const keys = await client.keys(`q:${r.id}:${u}:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^q:${r.id}:${u}:\\d{4}-\\d{2}$`));
    const ttl = await client.ttl(keys[0] ?? '');
    const expected = secondsToPeriodEnd('month', new Date(), 'UTC') + 86_400;
    expect(Math.abs(ttl - expected)).toBeLessThanOrEqual(3);

    await first.refund();
    expect((await limiter.readUsage(r, u)).consumed).toBe(1);
    await expect(limiter.check(op(u), [r], 'd')).resolves.toBeDefined();
  });

  it('14.2 quota: not consumed when the rate check rejects first', async () => {
    const limiter = createRedisLimiter({ redis: asPort(), timeZone: 'UTC' });
    const rt = rule({ kind: 'rate', params: { points: 1, perSeconds: 60, burst: 0 } });
    const q = rule({ kind: 'quota', params: { points: 10, period: 'day' } });
    const u = uniqueUser();
    await limiter.check(op(u), [q, rt], 'a');
    await expect(limiter.check(op(u), [q, rt], 'b')).rejects.toThrow(RateLimitedError);
    expect((await limiter.readUsage(q, u)).consumed).toBe(1);
  });

  it('21.3 Redis down: fails open to the per-worker limiter, then reports degraded', async () => {
    const own = await startRedis();
    const c = await connect(own.url);
    const events: Array<0 | 1> = [];
    const limiter = createLimiter({
      redis: c,
      expectedWorkers: 2,
      onDegraded: (v) => events.push(v),
    });
    const r = rule({ kind: 'rate', params: { points: 4, perSeconds: 60, burst: 0 } });
    const u = uniqueUser();
    await limiter.check(op(u), [r], 'ok');
    expect(limiter.degraded).toBe(false);

    await own.stop();
    await limiter.check(op(u), [r], 'a'); // admitted by the local limiter
    expect(limiter.degraded).toBe(true);
    expect(events).toEqual([1]);
    await limiter.check(op(u), [r], 'b'); // 4 / 2 workers = 2 locally
    await expect(limiter.check(op(u), [r], 'c')).rejects.toThrow(RateLimitedError);
    c.disconnect();
  }, 60_000);
});

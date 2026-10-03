import { META_KEYS, QuotaExceededError, RateLimitedError } from '@bastion-mcp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRedisLimiter,
  type OperationContext,
  type Principal,
  parseRule,
  type Rule,
} from '../src';
import { FakeRedis } from './fake-redis';

const principal: Principal = { orgId: 'o1', userId: 'u1' };
const op = (over: Partial<OperationContext> = {}): OperationContext => ({
  principal,
  method: 'tools/call',
  toolName: 'bq__run_query',
  ...over,
});

const rate = (over: Record<string, unknown> = {}): Rule =>
  parseRule({
    id: 'rate1',
    name: 'Calls per user',
    subject: 'user',
    kind: 'rate',
    params: { points: 3, perSeconds: 60, burst: 0 },
    ...over,
  });
const quota = (over: Record<string, unknown> = {}): Rule =>
  parseRule({
    id: 'quota1',
    name: 'Daily calls',
    subject: 'user',
    kind: 'quota',
    params: { points: 10, period: 'day' },
    ...over,
  });
const conc = (over: Record<string, unknown> = {}): Rule =>
  parseRule({
    id: 'conc1',
    name: 'In flight',
    subject: 'user',
    kind: 'concurrency',
    params: { max: 2, leaseSeconds: 900 },
    ...over,
  });

let redis: FakeRedis;
const make = () => createRedisLimiter({ redis, timeZone: 'UTC' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  redis = new FakeRedis();
});
afterEach(() => vi.useRealTimers());

describe('14.2 concurrency', () => {
  it('14.2 admits up to max in flight, then rejects with RATE_LIMITED', async () => {
    const limiter = make();
    await limiter.check(op(), [conc()], 'r1');
    await limiter.check(op(), [conc()], 'r2');
    const err = await limiter.check(op(), [conc()], 'r3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).data).toEqual({
      retryAfterMs: 1000,
      limit: 'In flight',
      kind: 'concurrency',
    });
    expect((err as RateLimitedError).mcpCode).toBe(-32011);
  });

  it('14.2 release frees the lease (finally) and is idempotent', async () => {
    const limiter = make();
    const a = await limiter.check(op(), [conc({ params: { max: 1, leaseSeconds: 900 } })], 'r1');
    await expect(
      limiter.check(op(), [conc({ params: { max: 1, leaseSeconds: 900 } })], 'r2'),
    ).rejects.toThrow(RateLimitedError);
    await a.release();
    await a.release();
    await expect(
      limiter.check(op(), [conc({ params: { max: 1, leaseSeconds: 900 } })], 'r3'),
    ).resolves.toBeDefined();
  });

  it('14.2 leases expire on their own when a worker dies', async () => {
    const limiter = make();
    const rules = [conc({ params: { max: 1, leaseSeconds: 30 } })];
    await limiter.check(op(), rules, 'dead-worker');
    await expect(limiter.check(op(), rules, 'r2')).rejects.toThrow(RateLimitedError);
    vi.advanceTimersByTime(31_000);
    await expect(limiter.check(op(), rules, 'r3')).resolves.toBeDefined();
  });

  it('14.2 concurrency counters are per subject', async () => {
    const limiter = make();
    const rules = [conc({ params: { max: 1, leaseSeconds: 900 } })];
    await limiter.check(op(), rules, 'a');
    await expect(
      limiter.check(op({ principal: { orgId: 'o1', userId: 'u2' } }), rules, 'b'),
    ).resolves.toBeDefined();
  });
});

describe('14.2 rate', () => {
  it('14.2 rejects over the sustained rate with retryAfterMs and the rule name', async () => {
    const limiter = make();
    const rules = [rate()];
    for (let i = 0; i < 3; i++) await limiter.check(op(), rules, `r${i}`);
    const err = await limiter.check(op(), rules, 'r9').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    const data = (err as RateLimitedError).data as { retryAfterMs: number; limit: string };
    expect(data.limit).toBe('Calls per user');
    expect(data.retryAfterMs).toBeGreaterThan(0);
    expect(data.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('14.2 the burst allowance admits calls beyond the sustained rate', async () => {
    const limiter = make();
    const rules = [rate({ params: { points: 2, perSeconds: 60, burst: 2 } })];
    for (let i = 0; i < 4; i++) await limiter.check(op(), rules, `r${i}`);
    await expect(limiter.check(op(), rules, 'r5')).rejects.toThrow(RateLimitedError);
  });

  it('14.2 the window slides: points return after perSeconds', async () => {
    const limiter = make();
    const rules = [rate()];
    for (let i = 0; i < 3; i++) await limiter.check(op(), rules, `r${i}`);
    vi.advanceTimersByTime(61_000);
    await expect(limiter.check(op(), rules, 'later')).resolves.toBeDefined();
  });

  it('14.1 cost weights charge expensive tools more points', async () => {
    const limiter = make();
    const rules = [rate({ cost: { bq__run_query: 3 } })];
    await limiter.check(op(), rules, 'r1');
    await expect(limiter.check(op(), rules, 'r2')).rejects.toThrow(RateLimitedError);
    await expect(limiter.check(op({ toolName: 'cheap' }), rules, 'r3')).rejects.toThrow(
      RateLimitedError,
    );
  });

  it('14.1 action warn records the breach but admits', async () => {
    const limiter = make();
    const rules = [rate({ action: 'warn', params: { points: 1, perSeconds: 60, burst: 0 } })];
    await limiter.check(op(), rules, 'r1');
    const second = await limiter.check(op(), rules, 'r2');
    expect(second.warnings).toEqual([
      expect.objectContaining({ rule: 'rate1', kind: 'rate', retryAfterMs: expect.any(Number) }),
    ]);
  });
});

describe('14.2 quota', () => {
  it('14.2 rejects when exhausted with resetsAt at the period end', async () => {
    const limiter = make();
    const rules = [quota({ params: { points: 2, period: 'day' } })];
    await limiter.check(op(), rules, 'r1');
    await limiter.check(op(), rules, 'r2');
    const err = await limiter.check(op(), rules, 'r3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).data).toEqual({
      resetsAt: '2026-10-02T00:00:00.000Z',
      quota: 'Daily calls',
    });
    expect((err as QuotaExceededError).mcpCode).toBe(-32012);
  });

  it('14.2 the key encodes the period and the counter resets at the boundary', async () => {
    const limiter = make();
    const rules = [quota({ params: { points: 1, period: 'day' } })];
    await limiter.check(op(), rules, 'r1');
    expect([...redis.counters.keys()]).toEqual(['q:quota1:u1:2026-10-01']);
    await expect(limiter.check(op(), rules, 'r2')).rejects.toThrow(QuotaExceededError);
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    await expect(limiter.check(op(), rules, 'r3')).resolves.toBeDefined();
    expect([...redis.counters.keys()]).toContain('q:quota1:u1:2026-10-02');
  });

  it('19.2 computes periods in the org time zone', async () => {
    const limiter = createRedisLimiter({ redis, timeZone: () => 'America/New_York' });
    vi.setSystemTime(new Date('2026-10-01T03:00:00Z'));
    await limiter.check(op(), [quota()], 'r1');
    expect([...redis.counters.keys()]).toEqual(['q:quota1:u1:2026-09-30']);
  });

  it('14.2 sets the key TTL to seconds-to-period-end plus one day', async () => {
    const limiter = make();
    await limiter.check(op(), [quota()], 'r1');
    const entry = redis.counters.get('q:quota1:u1:2026-10-01');
    const ttl = (entry?.expiresAt ?? 0) - Date.now();
    expect(ttl).toBe((12 * 3600 + 86_400) * 1000);
  });

  it('14.2 refund gives points back when the upstream was never reached', async () => {
    const limiter = make();
    const rules = [quota({ params: { points: 1, period: 'day' } })];
    const a = await limiter.check(op(), rules, 'r1');
    await a.refund();
    await a.refund();
    await expect(limiter.check(op(), rules, 'r2')).resolves.toBeDefined();
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(1);
  });

  it('14.2 quota points are consumed only after the rate check passes', async () => {
    const limiter = make();
    const rules = [
      quota({ params: { points: 5, period: 'day' } }),
      rate({ params: { points: 1, perSeconds: 60, burst: 0 } }),
    ];
    await limiter.check(op(), rules, 'r1');
    await expect(limiter.check(op(), rules, 'r2')).rejects.toThrow(RateLimitedError);
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(1);
  });

  it('14.2 a rejected quota does not keep its probe points', async () => {
    const limiter = make();
    const rules = [quota({ params: { points: 1, period: 'day' } })];
    await limiter.check(op(), rules, 'r1');
    await expect(limiter.check(op(), rules, 'r2')).rejects.toThrow(QuotaExceededError);
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(1);
  });

  it('14.2 order: a concurrency rejection consumes nothing; a later rejection releases the lease', async () => {
    const limiter = make();
    const full = [conc({ params: { max: 1, leaseSeconds: 900 } }), quota()];
    await limiter.check(op(), full, 'r1');
    await expect(limiter.check(op(), full, 'r2')).rejects.toThrow(RateLimitedError);
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(1);

    const rejecting = [
      conc({ id: 'c2' }),
      rate({ id: 'tight', params: { points: 1, perSeconds: 60, burst: 0 } }),
    ];
    await limiter.check(op(), rejecting, 'x1');
    await expect(limiter.check(op(), rejecting, 'x2')).rejects.toThrow(RateLimitedError);
    expect(redis.zsets.get('conc:c2:u1')?.size).toBe(1);
  });

  it('14.2 warn quota records and admits without keeping the points', async () => {
    const limiter = make();
    const rules = [quota({ action: 'warn', params: { points: 1, period: 'day' } })];
    await limiter.check(op(), rules, 'r1');
    const second = await limiter.check(op(), rules, 'r2');
    expect(second.warnings[0]).toMatchObject({
      kind: 'quota',
      resetsAt: '2026-10-02T00:00:00.000Z',
    });
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(1);
  });

  it('14.4 carries limits feedback _meta when under 10% is left', async () => {
    const limiter = make();
    const rules = [quota({ params: { points: 20, period: 'day' } })];
    const metas: unknown[] = [];
    for (let i = 0; i < 20; i++) metas.push((await limiter.check(op(), rules, `r${i}`)).meta);
    // 2 left of 20 is exactly 10%, not under it; 1 left and 0 left are.
    expect(metas.slice(0, 18).every((m) => m === undefined)).toBe(true);
    expect(metas[18]).toEqual({
      [META_KEYS.limits]: { rule: 'quota1', remaining: 1, resetsAt: '2026-10-02T00:00:00.000Z' },
    });
    expect(metas[19]).toEqual({
      [META_KEYS.limits]: { rule: 'quota1', remaining: 0, resetsAt: '2026-10-02T00:00:00.000Z' },
    });
  });
});

describe('14.1 rule selection at check time', () => {
  it('14.1 ignores rules whose scope or metric does not match the operation', async () => {
    const limiter = make();
    const rules = [
      rate({ scope: { tool: 'gh__*' }, params: { points: 1, perSeconds: 60, burst: 0 } }),
      quota({ id: 'sampling', metric: 'samplingRequests' }),
    ];
    for (let i = 0; i < 3; i++) await limiter.check(op(), rules, `r${i}`);
    expect(redis.counters.size).toBe(0);
    const sampled = await limiter.check(op({ amounts: { samplingRequests: 2 } }), rules, 'r');
    expect(sampled).toBeDefined();
    expect(redis.counters.get('q:sampling:u1:2026-10-01')?.value).toBe(2);
  });

  it('14.1 each team gets its own counter', async () => {
    const limiter = make();
    const rules = [rate({ subject: 'team', params: { points: 1, perSeconds: 60, burst: 0 } })];
    const teams = { orgId: 'o1', userId: 'u1', teamIds: ['t1', 't2'] };
    await limiter.check(op({ principal: teams }), rules, 'r1');
    expect([...redis.counters.keys()].sort()).toEqual(['rl:rate1:t1', 'rl:rate1:t2']);
  });
});

describe('14.4 usage reporting', () => {
  it('14.4 readUsage reports consumed, remaining and resetsAt without consuming', async () => {
    const limiter = make();
    const q = quota({ params: { points: 10, period: 'day' } });
    await limiter.check(op(), [q], 'r1');
    await limiter.check(op(), [q], 'r2');
    const before = redis.counters.get('q:quota1:u1:2026-10-01')?.value;
    expect(await limiter.readUsage(q, 'u1')).toEqual({
      ruleId: 'quota1',
      kind: 'quota',
      subjectId: 'u1',
      limit: 10,
      consumed: 2,
      remaining: 8,
      resetsAt: '2026-10-02T00:00:00.000Z',
    });
    expect(redis.counters.get('q:quota1:u1:2026-10-01')?.value).toBe(before);
    expect((await limiter.readUsage(q, 'nobody')).consumed).toBe(0);
  });

  it('14.4 readUsage covers rate and concurrency rules', async () => {
    const limiter = make();
    const r = rate();
    const c = conc();
    await limiter.check(op(), [r, c], 'r1');
    const rateUsage = await limiter.readUsage(r, 'u1');
    expect(rateUsage).toMatchObject({ kind: 'rate', limit: 3, consumed: 1, remaining: 2 });
    expect(rateUsage.resetsAt).toBe('2026-10-01T12:01:00.000Z');
    expect(await limiter.readUsage(c, 'u1')).toMatchObject({
      kind: 'concurrency',
      limit: 2,
      consumed: 1,
      remaining: 1,
      resetsAt: null,
    });
    expect(await limiter.readUsage(r, 'nobody')).toMatchObject({ consumed: 0, resetsAt: null });
  });
});

describe('21.3 backend failures surface as LimiterBackendError', () => {
  it('21.3 Redis errors are not mistaken for limit rejections', async () => {
    const limiter = make();
    redis.failing = true;
    await expect(limiter.check(op(), [rate()], 'r1')).rejects.toMatchObject({
      code: 'LIMITER_BACKEND_UNAVAILABLE',
    });
    await expect(limiter.check(op(), [conc()], 'r1')).rejects.toMatchObject({
      code: 'LIMITER_BACKEND_UNAVAILABLE',
    });
    await expect(limiter.check(op(), [quota()], 'r1')).rejects.toMatchObject({
      code: 'LIMITER_BACKEND_UNAVAILABLE',
    });
    await expect(limiter.readUsage(rate(), 'u1')).rejects.toMatchObject({
      code: 'LIMITER_BACKEND_UNAVAILABLE',
    });
  });
});

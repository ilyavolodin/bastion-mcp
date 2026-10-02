import { readFileSync } from 'node:fs';
import { RateLimitedError } from '@bastion-mcp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACQUIRE_LUA,
  createLimiter,
  DEGRADED_METRIC,
  FloodLimiter,
  floodBucketFor,
  type OperationContext,
  parseRule,
  planSandboxStart,
  type Rule,
} from '../src';
import { FakeRedis } from './fake-redis';

const op: OperationContext = { principal: { orgId: 'o', userId: 'u1' }, method: 'tools/call' };
const rate = (points: number): Rule =>
  parseRule({
    id: 'rl',
    name: 'Calls',
    subject: 'user',
    kind: 'rate',
    params: { points, perSeconds: 60, burst: 0 },
  });
const conc = (max: number): Rule =>
  parseRule({
    id: 'cc',
    name: 'Concurrent',
    subject: 'user',
    kind: 'concurrency',
    params: { max, leaseSeconds: 900 },
  });
const quota = (points: number): Rule =>
  parseRule({
    id: 'qq',
    name: 'Daily',
    subject: 'user',
    kind: 'quota',
    params: { points, period: 'day' },
  });

describe('14.2 / 21.3 Redis outage', () => {
  let redis: FakeRedis;
  let events: Array<0 | 1>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    redis = new FakeRedis();
    events = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (expectedWorkers = 3) =>
    createLimiter({
      redis,
      expectedWorkers,
      timeZone: 'UTC',
      onDegraded: (v) => events.push(v),
      probeIntervalMs: 5000,
    });

  it('21.3 exposes the metric name', () => {
    expect(DEGRADED_METRIC).toBe('bastion.limits.degraded');
  });

  it('21.3 healthy Redis: no degraded signal and Redis rules apply fleet-wide', async () => {
    const limiter = make();
    await limiter.check(op, [rate(2)], 'r1');
    expect(limiter.degraded).toBe(false);
    expect(events).toEqual([]);
    expect(redis.counters.size).toBe(1);
  });

  it('14.2 fails open to a per-worker limiter at 1/BASTION_EXPECTED_WORKERS of each rule', async () => {
    const limiter = make(3);
    redis.failing = true;
    const rules = [rate(6)]; // 6 / 3 workers = 2 on this worker
    await limiter.check(op, rules, 'r1');
    await limiter.check(op, rules, 'r2');
    expect(limiter.degraded).toBe(true);
    expect(events).toEqual([1]);
    await expect(limiter.check(op, rules, 'r3')).rejects.toThrow(RateLimitedError);
  });

  it('21.3 scales concurrency and quota rules and never goes below one point', async () => {
    const limiter = make(4);
    redis.failing = true;
    await limiter.check(op, [conc(8)], 'a');
    await limiter.check(op, [conc(8)], 'b');
    await expect(limiter.check(op, [conc(8)], 'c')).rejects.toThrow(RateLimitedError);
    const a = await limiter.check(op, [quota(2)], 'q1'); // 2/4 -> 1
    await expect(limiter.check(op, [quota(2)], 'q2')).rejects.toThrow();
    await a.refund();
    await expect(limiter.check(op, [quota(2)], 'q3')).resolves.toBeDefined();
  });

  it('21.3 fallback release frees memory leases', async () => {
    const limiter = make(1);
    redis.failing = true;
    const a = await limiter.check(op, [conc(1)], 'a');
    await expect(limiter.check(op, [conc(1)], 'b')).rejects.toThrow(RateLimitedError);
    await a.release();
    await expect(limiter.check(op, [conc(1)], 'c')).resolves.toBeDefined();
  });

  it('14.2 recovers automatically when Redis comes back, probing at the configured interval', async () => {
    const limiter = make(3);
    redis.failing = true;
    await limiter.check(op, [rate(3)], 'r1');
    expect(limiter.degraded).toBe(true);

    redis.failing = false;
    await limiter.check(op, [rate(30)], 'r2'); // still inside the probe interval: local
    expect(limiter.degraded).toBe(true);
    expect(redis.counters.size).toBe(0);

    vi.advanceTimersByTime(5001);
    await limiter.check(op, [rate(30)], 'r3');
    expect(limiter.degraded).toBe(false);
    expect(events).toEqual([1, 0]);
    expect(redis.counters.size).toBe(1);
  });

  it('14.2 a hung Redis counts as an outage after the timeout', async () => {
    const limiter = createLimiter({
      redis,
      expectedWorkers: 1,
      timeZone: 'UTC',
      redisTimeoutMs: 50,
      onDegraded: (v) => events.push(v),
    });
    redis.hanging = true;
    const pending = limiter.check(op, [rate(5)], 'r1');
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeDefined();
    expect(events).toEqual([1]);
  });

  it('14.2 limit rejections are not outages', async () => {
    const limiter = make(1);
    await limiter.check(op, [rate(1)], 'r1');
    await expect(limiter.check(op, [rate(1)], 'r2')).rejects.toThrow(RateLimitedError);
    expect(limiter.degraded).toBe(false);
  });

  it('14.2 release failures during an outage are swallowed (leases expire on their own)', async () => {
    const limiter = make(1);
    const a = await limiter.check(op, [conc(2)], 'a');
    redis.failing = true;
    await expect(a.release()).resolves.toBeUndefined();
  });

  it('14.4 readUsage reads from Redis', async () => {
    const limiter = make(1);
    await limiter.check(op, [rate(5)], 'r1');
    expect((await limiter.readUsage(rate(5), 'u1')).consumed).toBe(1);
  });
});

describe('14.2 pre-auth flood control', () => {
  it('14.2 allows 1,000 per minute per IP on /mcp* then answers with Retry-After', async () => {
    const flood = new FloodLimiter();
    for (let i = 0; i < 1000; i++) expect((await flood.check('1.2.3.4', 'mcp')).ok).toBe(true);
    const blocked = await flood.check('1.2.3.4', 'mcp');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    expect((await flood.check('5.6.7.8', 'mcp')).ok).toBe(true);
  });

  it('14.2 allows 60 per minute on the oauth endpoints, independent of the mcp bucket', async () => {
    const flood = new FloodLimiter();
    for (let i = 0; i < 60; i++) await flood.check('9.9.9.9', 'oauth');
    expect((await flood.check('9.9.9.9', 'oauth')).ok).toBe(false);
    expect((await flood.check('9.9.9.9', 'mcp')).ok).toBe(true);
  });

  it('14.2 maps paths to buckets', () => {
    expect(floodBucketFor('/mcp')).toBe('mcp');
    expect(floodBucketFor('/mcp/team/abc?x=1')).toBe('mcp');
    expect(floodBucketFor('/oauth/token')).toBe('oauth');
    expect(floodBucketFor('/oauth/register')).toBe('oauth');
    expect(floodBucketFor('/oauth/authorize')).toBeUndefined();
    expect(floodBucketFor('/mcpx')).toBeUndefined();
    expect(floodBucketFor('/api/v1/me')).toBeUndefined();
  });
});

describe('8.6 running-sandbox cap', () => {
  const inst = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    state: 'running',
    idleEligible: true,
    lastUsedAt: new Date(`2026-10-01T0${id}:00:00Z`),
    ...over,
  });

  it('8.6 starts when below the cap', () => {
    expect(planSandboxStart([inst('1'), inst('2')], 3)).toEqual({ action: 'start' });
    expect(planSandboxStart([inst('1', { state: 'stopped' })], 1)).toEqual({ action: 'start' });
  });

  it('8.6 at the cap stops the least recently used idle-eligible instance', () => {
    const plan = planSandboxStart(
      [inst('3'), inst('1'), inst('2', { idleEligible: false, lastUsedAt: 0 })],
      3,
    );
    expect(plan).toEqual({ action: 'stop-then-start', stopInstanceId: '1' });
  });

  it('8.6 never stops an instance that is still starting or busy', () => {
    const plan = planSandboxStart(
      [inst('1', { state: 'starting' }), inst('2', { idleEligible: false })],
      2,
    );
    expect(plan.action).toBe('reject');
  });

  it('8.6 fails with -32011 when nothing can be stopped', () => {
    const plan = planSandboxStart([inst('1', { idleEligible: false })], 1);
    expect(plan.action === 'reject' && plan.error.mcpCode).toBe(-32011);
    expect(plan.action === 'reject' && plan.error).toBeInstanceOf(RateLimitedError);
  });
});

describe('14.2 Lua bundle', () => {
  it('14.2 the bundled string constant equals lua/acquire.lua', () => {
    const file = readFileSync(new URL('../lua/acquire.lua', import.meta.url), 'utf8');
    expect(ACQUIRE_LUA.trim()).toBe(file.replace(/\r\n/g, '\n').trim());
  });

  it('14.2 the script checks ZCARD against max, removes expired leases and ZADDs the lease', () => {
    expect(ACQUIRE_LUA).toContain('ZREMRANGEBYSCORE');
    expect(ACQUIRE_LUA).toContain('ZCARD');
    expect(ACQUIRE_LUA).toContain('ZADD');
  });
});

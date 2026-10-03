import { META_KEYS, QuotaExceededError, RateLimitedError } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { EngineLimiter, MemoryBackend, type OperationContext, parseRule, type Rule } from '../src';
import { memoize } from '../src/memoize';
import { periodWindow } from '../src/period';
import { concurrencyUsage, quotaUsage, rateUsage } from '../src/usage';

const op: OperationContext = {
  principal: { orgId: 'o1', userId: 'u1' },
  method: 'tools/call',
  toolName: 'bq__run_query',
};

const rule = (kind: 'rate' | 'quota' | 'concurrency', over: Record<string, unknown> = {}): Rule => {
  const params = {
    rate: { points: 2, perSeconds: 60, burst: 0 },
    quota: { points: 10, period: 'day' },
    concurrency: { max: 1, leaseSeconds: 900 },
  }[kind];
  return parseRule({
    id: `${kind}1`,
    name: `${kind} rule`,
    subject: 'user',
    kind,
    params,
    ...over,
  });
};

const fixedClock = (iso = '2026-10-01T12:00:00Z') => ({ now: () => new Date(iso) });

describe('14.2 EngineLimiter ordering and cleanup', () => {
  it('14.2 does not charge the quota when a rate rule rejects first', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), { clock: fixedClock() });
    const rules = [
      rule('rate', { params: { points: 1, perSeconds: 60, burst: 0 } }),
      rule('quota'),
    ];
    await (await limiter.check(op, rules, 'r1')).release();
    await expect(limiter.check(op, rules, 'r2')).rejects.toBeInstanceOf(RateLimitedError);
    const usage = await limiter.readUsage(rule('quota'), 'u1');
    expect(usage.consumed).toBe(1);
  });

  it('14.2 releases a taken lease when a later rule rejects', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), { clock: fixedClock() });
    const rules = [
      rule('concurrency', { params: { max: 5, leaseSeconds: 900 } }),
      rule('rate', { params: { points: 1, perSeconds: 60, burst: 0 } }),
    ];
    const first = await limiter.check(op, rules, 'r1');
    await first.release();
    await expect(limiter.check(op, rules, 'r2')).rejects.toBeInstanceOf(RateLimitedError);
    expect((await limiter.readUsage(rule('concurrency'), 'u1')).consumed).toBe(0);
  });

  it('14.2 a rejected concurrency check names the rule and uses the configured retry', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), {
      clock: fixedClock(),
      concurrencyRetryMs: 250,
    });
    await limiter.check(op, [rule('concurrency')], 'held');
    const error = await limiter.check(op, [rule('concurrency')], 'next').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).data).toMatchObject({
      retryAfterMs: 250,
      limit: 'concurrency rule',
    });
  });

  it('14.2 refund gives quota points back once, however often it is called', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), { clock: fixedClock() });
    const admission = await limiter.check(op, [rule('quota')], 'r1');
    expect((await limiter.readUsage(rule('quota'), 'u1')).consumed).toBe(1);
    await admission.refund();
    await admission.refund();
    expect((await limiter.readUsage(rule('quota'), 'u1')).consumed).toBe(0);
  });

  it('14.2 an exhausted reject quota throws with the reset time and keeps its count at the limit', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), { clock: fixedClock() });
    const tiny = rule('quota', { params: { points: 1, period: 'day' } });
    await limiter.check(op, [tiny], 'r1');
    const error = await limiter.check(op, [tiny], 'r2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).data).toMatchObject({
      quota: 'quota rule',
      resetsAt: '2026-10-02T00:00:00.000Z',
    });
    expect((await limiter.readUsage(tiny, 'u1')).consumed).toBe(1);
  });

  it('14.4 a warn action admits the call and reports a warning instead', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), { clock: fixedClock() });
    const warnRate = rule('rate', {
      action: 'warn',
      params: { points: 1, perSeconds: 60, burst: 0 },
    });
    await limiter.check(op, [warnRate], 'r1');
    const second = await limiter.check(op, [warnRate], 'r2');
    expect(second.warnings).toEqual([
      expect.objectContaining({ rule: 'rate1', kind: 'rate', retryAfterMs: expect.any(Number) }),
    ]);
  });

  it('14.4 adds limits feedback only below the warn fraction, for the tightest quota', async () => {
    const limiter = new EngineLimiter(new MemoryBackend(1), {
      clock: fixedClock(),
      warnBelowFraction: 0.5,
    });
    const q = rule('quota', { params: { points: 4, period: 'day' } });
    expect((await limiter.check(op, [q], 'r1')).meta).toBeUndefined();
    expect((await limiter.check(op, [q], 'r2')).meta).toBeUndefined();
    const third = await limiter.check(op, [q], 'r3');
    expect(third.meta?.[META_KEYS.limits]).toMatchObject({ rule: 'quota1', remaining: 1 });
  });

  it('19.2 reads the time zone again on every check when it is a function', async () => {
    let zone = 'UTC';
    const limiter = new EngineLimiter(new MemoryBackend(1), {
      clock: fixedClock('2026-10-01T23:30:00Z'),
      timeZone: () => zone,
    });
    const q = rule('quota');
    expect((await limiter.readUsage(q, 'u1')).resetsAt).toBe('2026-10-02T00:00:00.000Z');
    zone = 'Asia/Tokyo';
    expect((await limiter.readUsage(q, 'u1')).resetsAt).toBe('2026-10-02T15:00:00.000Z');
  });
});

describe('14.4 usage helpers', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('14.4 caps consumed at the limit and derives remaining and reset for a rate rule', () => {
    const r = rule('rate');
    expect(rateUsage(r as never, 'u1', 5, { consumedPoints: 9, msBeforeNext: 2000 }, now)).toEqual({
      ruleId: 'rate1',
      kind: 'rate',
      subjectId: 'u1',
      limit: 5,
      consumed: 5,
      remaining: 0,
      resetsAt: '2026-10-01T12:00:02.000Z',
    });
    expect(rateUsage(r as never, 'u1', 5, undefined, now)).toMatchObject({
      consumed: 0,
      remaining: 5,
      resetsAt: null,
    });
  });

  it('14.4 reports the period end for a quota rule', () => {
    const window = periodWindow('day', now, 'UTC');
    expect(
      quotaUsage(rule('quota') as never, 'u1', 10, { consumedPoints: 3, msBeforeNext: 0 }, window),
    ).toMatchObject({
      consumed: 3,
      remaining: 7,
      resetsAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('14.4 never reports negative remaining for concurrency', () => {
    expect(concurrencyUsage(rule('concurrency') as never, 'u1', 2, 5)).toMatchObject({
      consumed: 5,
      remaining: 0,
      resetsAt: null,
    });
  });
});

describe('memoize', () => {
  it('creates once per key and returns the cached value afterwards', () => {
    const cache = new Map<string, { n: number }>();
    let made = 0;
    const make = () => ({ n: ++made });
    const a = memoize(cache, 'k', make);
    expect(memoize(cache, 'k', make)).toBe(a);
    expect(memoize(cache, 'other', make)).not.toBe(a);
    expect(made).toBe(2);
  });
});

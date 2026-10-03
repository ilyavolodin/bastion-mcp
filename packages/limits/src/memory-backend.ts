import { redisKeys, SECONDS } from '@bastion-mcp/core';
import { BurstyRateLimiter, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { memoize } from './memoize';
import { type PeriodWindow, periodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, RateRule, Rule } from './rules';
import type { LimiterBackend, QuotaOutcome, RateOutcome, Usage } from './types';
import { concurrencyUsage, quotaUsage, rateUsage } from './usage';

/** Node timers overflow beyond about 24.8 days; memory counters live at most this long. */
const MAX_MEMORY_DURATION_SECONDS = 24 * SECONDS.DAY;

type RateCounter = {
  /** Sustained limiter, used for reads. */
  sustained: RateLimiterMemory;
  consume(key: string, points: number): Promise<RateLimiterRes>;
};

/**
 * Per-worker in-memory limiter used while Redis is down (14.2, 21.3). Every rule is scaled to
 * `1 / expectedWorkers` of its configured size (minimum one point), so the fleet as a whole stays near
 * the configured limit.
 */
export class MemoryBackend implements LimiterBackend {
  private readonly rateLimiters = new Map<string, RateCounter>();
  private readonly quotaLimiters = new Map<string, RateLimiterMemory>();
  private readonly leases = new Map<string, Map<string, number>>();

  constructor(private readonly expectedWorkers: number) {}

  /** A rule's size on this worker. */
  scale(points: number): number {
    return Math.max(1, Math.floor(points / this.expectedWorkers));
  }

  private rateLimiter(rule: RateRule): RateCounter {
    const { points, perSeconds, burst } = rule.params;
    return memoize(this.rateLimiters, `${rule.id}:${points}:${perSeconds}:${burst}`, () => {
      const sustained = new RateLimiterMemory({
        keyPrefix: '',
        points: this.scale(points),
        duration: perSeconds,
      });
      const bursty =
        burst > 0
          ? new BurstyRateLimiter(
              sustained,
              new RateLimiterMemory({
                keyPrefix: 'burst',
                points: this.scale(burst),
                duration: perSeconds,
              }),
            )
          : sustained;
      return { sustained, consume: (k, n) => bursty.consume(k, n) };
    });
  }

  private quotaLimiter(rule: QuotaRule): RateLimiterMemory {
    return memoize(
      this.quotaLimiters,
      `${rule.id}:${rule.params.points}`,
      () =>
        new RateLimiterMemory({
          keyPrefix: '',
          points: this.scale(rule.params.points),
          duration: SECONDS.DAY,
        }),
    );
  }

  async acquire(
    rule: ConcurrencyRule,
    subjectId: string,
    member: string,
    now: Date,
  ): Promise<{ ok: boolean; inFlight: number }> {
    const key = redisKeys.concurrency(rule.id, subjectId);
    let held = this.leases.get(key);
    if (!held) {
      held = new Map();
      this.leases.set(key, held);
    }
    const nowMs = now.getTime();
    for (const [id, expires] of held) if (expires <= nowMs) held.delete(id);
    if (held.size >= this.scale(rule.params.max)) return { ok: false, inFlight: held.size };
    held.set(member, nowMs + rule.params.leaseSeconds * 1000);
    return { ok: true, inFlight: held.size };
  }

  async release(rule: ConcurrencyRule, subjectId: string, member: string): Promise<void> {
    const key = redisKeys.concurrency(rule.id, subjectId);
    const held = this.leases.get(key);
    held?.delete(member);
    if (held && held.size === 0) this.leases.delete(key);
  }

  async consumeRate(rule: RateRule, subjectId: string, points: number): Promise<RateOutcome> {
    try {
      await this.rateLimiter(rule).consume(redisKeys.rate(rule.id, subjectId), points);
      return { ok: true };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { ok: false, retryAfterMs: Math.max(1, Math.ceil(error.msBeforeNext)) };
      }
      throw error;
    }
  }

  private duration(window: PeriodWindow): { customDuration: number } {
    return { customDuration: Math.min(window.durationSeconds, MAX_MEMORY_DURATION_SECONDS) };
  }

  async consumeQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<QuotaOutcome> {
    const key = redisKeys.quota(rule.id, subjectId, window.key);
    try {
      const res = await this.quotaLimiter(rule).consume(key, points, this.duration(window));
      return { ok: true, consumed: res.consumedPoints, remaining: res.remainingPoints };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { ok: false, consumed: error.consumedPoints, remaining: 0 };
      }
      throw error;
    }
  }

  async refundQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<void> {
    await this.quotaLimiter(rule).reward(
      redisKeys.quota(rule.id, subjectId, window.key),
      points,
      this.duration(window),
    );
  }

  async usage(rule: Rule, subjectId: string, now: Date, timeZone: string): Promise<Usage> {
    switch (rule.kind) {
      case 'rate': {
        const state = await this.rateLimiter(rule).sustained.get(
          redisKeys.rate(rule.id, subjectId),
        );
        return rateUsage(rule, subjectId, this.scale(rule.params.points), state, now);
      }
      case 'quota': {
        const window = periodWindow(rule.params.period, now, timeZone);
        const state = await this.quotaLimiter(rule).get(
          redisKeys.quota(rule.id, subjectId, window.key),
        );
        return quotaUsage(rule, subjectId, this.scale(rule.params.points), state, window);
      }
      case 'concurrency': {
        const held = this.leases.get(redisKeys.concurrency(rule.id, subjectId));
        const nowMs = now.getTime();
        const live = held ? [...held.values()].filter((e) => e > nowMs).length : 0;
        return concurrencyUsage(rule, subjectId, this.scale(rule.params.max), live);
      }
    }
  }
}

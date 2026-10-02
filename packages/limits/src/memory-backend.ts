import { redisKeys } from '@bastion-mcp/core';
import { BurstyRateLimiter, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { type PeriodWindow, periodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, RateRule, Rule } from './rules';
import type { LimiterBackend, QuotaOutcome, RateOutcome, Usage } from './types';

/** Node timers overflow beyond about 24.8 days; memory counters live at most this long. */
const MAX_MEMORY_DURATION_SECONDS = 24 * 86_400;

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
    const id = `${rule.id}:${points}:${perSeconds}:${burst}`;
    let limiter = this.rateLimiters.get(id);
    if (!limiter) {
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
      limiter = { sustained, consume: (k, n) => bursty.consume(k, n) };
      this.rateLimiters.set(id, limiter);
    }
    return limiter;
  }

  private quotaLimiter(rule: QuotaRule): RateLimiterMemory {
    const id = `${rule.id}:${rule.params.points}`;
    let limiter = this.quotaLimiters.get(id);
    if (!limiter) {
      limiter = new RateLimiterMemory({
        keyPrefix: '',
        points: this.scale(rule.params.points),
        duration: 86_400,
      });
      this.quotaLimiters.set(id, limiter);
    }
    return limiter;
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
    const base = { ruleId: rule.id, kind: rule.kind, subjectId } as const;
    switch (rule.kind) {
      case 'rate': {
        const limit = this.scale(rule.params.points);
        const res = await this.rateLimiter(rule).sustained.get(redisKeys.rate(rule.id, subjectId));
        const consumed = Math.min(res?.consumedPoints ?? 0, limit);
        return {
          ...base,
          limit,
          consumed,
          remaining: limit - consumed,
          resetsAt: res ? new Date(now.getTime() + res.msBeforeNext).toISOString() : null,
        };
      }
      case 'quota': {
        const limit = this.scale(rule.params.points);
        const window = periodWindow(rule.params.period, now, timeZone);
        const res = await this.quotaLimiter(rule).get(
          redisKeys.quota(rule.id, subjectId, window.key),
        );
        const consumed = Math.min(res?.consumedPoints ?? 0, limit);
        return {
          ...base,
          limit,
          consumed,
          remaining: limit - consumed,
          resetsAt: window.resetsAt.toISOString(),
        };
      }
      case 'concurrency': {
        const limit = this.scale(rule.params.max);
        const held = this.leases.get(redisKeys.concurrency(rule.id, subjectId));
        const nowMs = now.getTime();
        const consumed = held ? [...held.values()].filter((e) => e > nowMs).length : 0;
        return {
          ...base,
          limit,
          consumed,
          remaining: Math.max(0, limit - consumed),
          resetsAt: null,
        };
      }
    }
  }
}

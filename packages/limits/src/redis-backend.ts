import { redisKeys, SECONDS } from '@bastion-mcp/core';
import { BurstyRateLimiter, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { z } from 'zod';
import { ACQUIRE_LUA } from './acquire-script';
import { memoize } from './memoize';
import { type PeriodWindow, periodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, RateRule, Rule } from './rules';
import {
  type LimiterBackend,
  LimiterBackendError,
  type QuotaOutcome,
  type RateOutcome,
  type RedisLike,
  type Usage,
} from './types';
import { concurrencyUsage, quotaUsage, rateUsage } from './usage';

const AcquireReplySchema = z.tuple([z.number(), z.number()]);

type RateCounter = {
  /** Sustained limiter, used for reads. */
  sustained: RateLimiterRedis;
  consume(key: string, points: number): Promise<RateLimiterRes>;
};

/** Wraps anything that is not a limit rejection as a backend failure so callers can fail open (21.3). */
const backendFailure = (error: unknown): LimiterBackendError =>
  error instanceof LimiterBackendError
    ? error
    : new LimiterBackendError('Limit store unavailable', error);

/**
 * Redis-backed limiter state (14.2). Keys come from `redisKeys`; every Redis operation touches one key, so
 * Redis Cluster needs no hash tags beyond the key itself (21.1).
 */
export class RedisBackend implements LimiterBackend {
  private readonly rateLimiters = new Map<string, RateCounter>();
  private readonly quotaLimiters = new Map<string, RateLimiterRedis>();

  constructor(private readonly redis: RedisLike) {
    redis.defineCommand('bastionAcquire', { numberOfKeys: 1, lua: ACQUIRE_LUA });
  }

  private rateLimiter(rule: RateRule): RateCounter {
    const { points, perSeconds, burst } = rule.params;
    return memoize(this.rateLimiters, `${rule.id}:${points}:${perSeconds}:${burst}`, () => {
      const sustained = new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: '',
        points,
        duration: perSeconds,
      });
      if (burst <= 0) return { sustained, consume: (k, n) => sustained.consume(k, n) };
      const bursty = new BurstyRateLimiter(
        sustained,
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: 'burst',
          points: burst,
          duration: perSeconds,
        }),
      );
      return { sustained, consume: (k, n) => bursty.consume(k, n) };
    });
  }

  private quotaLimiter(rule: QuotaRule): RateLimiterRedis {
    return memoize(
      this.quotaLimiters,
      `${rule.id}:${rule.params.points}`,
      () =>
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: '',
          points: rule.params.points,
          // Overridden per call with the exact seconds to the period end plus one day (14.2).
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
    const acquire = this.redis.bastionAcquire;
    if (!acquire) throw new LimiterBackendError('Semaphore script is not loaded');
    try {
      const nowMs = now.getTime();
      const reply = AcquireReplySchema.parse(
        await acquire.call(
          this.redis,
          redisKeys.concurrency(rule.id, subjectId),
          nowMs,
          nowMs + rule.params.leaseSeconds * 1000,
          rule.params.max,
          member,
        ),
      );
      return { ok: reply[0] === 1, inFlight: reply[1] };
    } catch (error) {
      throw backendFailure(error);
    }
  }

  async release(rule: ConcurrencyRule, subjectId: string, member: string): Promise<void> {
    try {
      await this.redis.zrem(redisKeys.concurrency(rule.id, subjectId), member);
    } catch (error) {
      throw backendFailure(error);
    }
  }

  async consumeRate(rule: RateRule, subjectId: string, points: number): Promise<RateOutcome> {
    try {
      await this.rateLimiter(rule).consume(redisKeys.rate(rule.id, subjectId), points);
      return { ok: true };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { ok: false, retryAfterMs: Math.max(1, Math.ceil(error.msBeforeNext)) };
      }
      throw backendFailure(error);
    }
  }

  async consumeQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<QuotaOutcome> {
    const key = redisKeys.quota(rule.id, subjectId, window.key);
    try {
      const res = await this.quotaLimiter(rule).consume(key, points, {
        customDuration: window.durationSeconds,
      });
      return { ok: true, consumed: res.consumedPoints, remaining: res.remainingPoints };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { ok: false, consumed: error.consumedPoints, remaining: 0 };
      }
      throw backendFailure(error);
    }
  }

  async refundQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<void> {
    try {
      await this.quotaLimiter(rule).reward(
        redisKeys.quota(rule.id, subjectId, window.key),
        points,
        { customDuration: window.durationSeconds },
      );
    } catch (error) {
      throw backendFailure(error);
    }
  }

  async usage(rule: Rule, subjectId: string, now: Date, timeZone: string): Promise<Usage> {
    try {
      switch (rule.kind) {
        case 'rate': {
          const state = await this.rateLimiter(rule).sustained.get(
            redisKeys.rate(rule.id, subjectId),
          );
          return rateUsage(rule, subjectId, rule.params.points, state, now);
        }
        case 'quota': {
          const window = periodWindow(rule.params.period, now, timeZone);
          const state = await this.quotaLimiter(rule).get(
            redisKeys.quota(rule.id, subjectId, window.key),
          );
          return quotaUsage(rule, subjectId, rule.params.points, state, window);
        }
        case 'concurrency': {
          const inFlight = await this.redis.zcount(
            redisKeys.concurrency(rule.id, subjectId),
            `(${now.getTime()}`,
            '+inf',
          );
          return concurrencyUsage(rule, subjectId, rule.params.max, inFlight);
        }
      }
    } catch (error) {
      throw backendFailure(error);
    }
  }
}

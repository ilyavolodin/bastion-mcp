import { BastionError } from '@bastion-mcp/core';
import type { OperationContext } from './match';
import type { PeriodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, RateRule, Rule } from './rules';

/** Time source port. Tests inject a fake; production uses `systemClock`. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Chainable command batch: the subset `rate-limiter-flexible` uses to read counters. */
export interface RedisMulti {
  get(key: string): RedisMulti;
  pttl(key: string): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * The subset of an `ioredis` v5 client the limiter needs. `defineCommand` registers the Lua scripts
 * (`rlflxIncr` for counters, `bastionAcquire` for the semaphore); unit tests inject fakes.
 */
export interface RedisLike {
  status?: string;
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  multi(): RedisMulti;
  zrem(key: string, member: string): Promise<number>;
  zcount(key: string, min: string | number, max: string | number): Promise<number>;
  /** Added by `defineCommand('bastionAcquire', ...)`. */
  bastionAcquire?:
    | ((
        key: string,
        nowMs: number,
        expiresMs: number,
        max: number,
        member: string,
      ) => Promise<unknown>)
    | undefined;
}

/** The storage behind the limiter (Redis, or memory while Redis is down). Throws `LimiterBackendError`. */
export class LimiterBackendError extends BastionError {
  constructor(message: string, cause?: unknown) {
    super('LIMITER_BACKEND_UNAVAILABLE', message, { httpStatus: 503, cause });
  }
}

export type RateOutcome = { ok: true } | { ok: false; retryAfterMs: number };
export type QuotaOutcome = { ok: boolean; consumed: number; remaining: number };

/** What a rule has used right now, read without consuming. */
export type Usage = {
  ruleId: string;
  kind: Rule['kind'];
  subjectId: string;
  limit: number;
  consumed: number;
  remaining: number;
  /** ISO time the counter resets; null for concurrency (leases free up as calls finish). */
  resetsAt: string | null;
};

export interface LimiterBackend {
  acquire(
    rule: ConcurrencyRule,
    subjectId: string,
    member: string,
    now: Date,
  ): Promise<{ ok: boolean; inFlight: number }>;
  release(rule: ConcurrencyRule, subjectId: string, member: string): Promise<void>;
  consumeRate(rule: RateRule, subjectId: string, points: number): Promise<RateOutcome>;
  consumeQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<QuotaOutcome>;
  refundQuota(
    rule: QuotaRule,
    subjectId: string,
    points: number,
    window: PeriodWindow,
  ): Promise<void>;
  usage(rule: Rule, subjectId: string, now: Date, timeZone: string): Promise<Usage>;
}

/** `_meta["io.github.bastion-mcp/limits"]` payload (14.4). */
export type LimitsMeta = { rule: string; remaining: number; resetsAt: string };

export type LimitWarning = {
  rule: string;
  kind: Rule['kind'];
  retryAfterMs?: number;
  resetsAt?: string;
};

/** Result of an admitted call. */
export interface Admission {
  /** Present when a quota has under 10% left (14.4); merge into the result `_meta`. */
  readonly meta: Record<string, LimitsMeta> | undefined;
  /** Rules with action `warn` that would have rejected. */
  readonly warnings: readonly LimitWarning[];
  /** Releases concurrency leases. Idempotent; call in a `finally`. */
  release(): Promise<void>;
  /** Gives back quota points when the call failed before reaching the upstream. Idempotent. */
  refund(): Promise<void>;
}

export interface Limiter {
  /**
   * Evaluates concurrency, then rate, then quota (14.2). Throws `RateLimitedError` or
   * `QuotaExceededError` when a `reject` rule trips; leases taken so far are released.
   */
  check(op: OperationContext, rules: readonly Rule[], requestId: string): Promise<Admission>;
  /** Current consumption of one rule for one subject, without consuming. */
  readUsage(rule: Rule, subjectId: string): Promise<Usage>;
}

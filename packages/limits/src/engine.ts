import { META_KEYS, QuotaExceededError, RateLimitedError } from '@bastion-mcp/core';
import { matchRule, type OperationContext, pointsFor, subjectIdsFor } from './match';
import { type PeriodWindow, periodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, Rule } from './rules';
import {
  type Admission,
  type Clock,
  type Limiter,
  type LimiterBackend,
  type LimitsMeta,
  type LimitWarning,
  systemClock,
  type Usage,
} from './types';

export type TimeZoneSource = string | (() => string);

export type EngineOptions = {
  clock?: Clock;
  /** Org time zone for quota periods (19.2); a function lets the org setting change at runtime. */
  timeZone?: TimeZoneSource;
  /** `retryAfterMs` reported when a concurrency cap is full. */
  concurrencyRetryMs?: number;
  /** Fraction of a quota left under which results carry limits feedback (14.4). */
  warnBelowFraction?: number;
};

const WARN_BELOW_FRACTION = 0.1;

const resolveZone = (source: TimeZoneSource | undefined): string =>
  typeof source === 'function' ? source() : (source ?? 'UTC');

type Entry<R extends Rule> = { rule: R; subjectId: string; points: number };

/**
 * Evaluates rules against a `LimiterBackend` in the order of 14.2: concurrency, rate, quota. Quota points
 * are consumed only after every concurrency and rate rule has passed.
 */
export class EngineLimiter implements Limiter {
  private readonly clock: Clock;
  private readonly timeZone: TimeZoneSource | undefined;
  private readonly concurrencyRetryMs: number;
  private readonly warnBelow: number;

  constructor(
    private readonly backend: LimiterBackend,
    options: EngineOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.timeZone = options.timeZone;
    this.concurrencyRetryMs = options.concurrencyRetryMs ?? 1000;
    this.warnBelow = options.warnBelowFraction ?? WARN_BELOW_FRACTION;
  }

  async check(op: OperationContext, rules: readonly Rule[], requestId: string): Promise<Admission> {
    const entries: Entry<Rule>[] = [];
    for (const rule of rules) {
      if (!matchRule(rule, op)) continue;
      const points = pointsFor(rule, op);
      for (const subjectId of subjectIdsFor(rule, op.principal)) {
        entries.push({ rule, subjectId, points });
      }
    }
    const concurrency = entries.filter(
      (e): e is Entry<ConcurrencyRule> => e.rule.kind === 'concurrency',
    );
    const rate = entries.filter((e) => e.rule.kind === 'rate');
    const quota = entries.filter((e): e is Entry<QuotaRule> => e.rule.kind === 'quota');

    const now = this.clock.now();
    const leases: Entry<ConcurrencyRule>[] = [];
    const charges: Array<Entry<QuotaRule> & { window: PeriodWindow }> = [];
    const warnings: LimitWarning[] = [];
    let meta: Record<string, LimitsMeta> | undefined;
    let metaFraction = Number.POSITIVE_INFINITY;

    const release = async (): Promise<void> => {
      const taken = leases.splice(0);
      await Promise.allSettled(
        taken.map((l) => this.backend.release(l.rule, l.subjectId, requestId)),
      );
    };
    let refunded = false;
    const refund = async (): Promise<void> => {
      if (refunded) return;
      refunded = true;
      await Promise.allSettled(
        charges.map((c) => this.backend.refundQuota(c.rule, c.subjectId, c.points, c.window)),
      );
    };

    try {
      for (const e of concurrency) {
        const res = await this.backend.acquire(e.rule, e.subjectId, requestId, now);
        if (res.ok) {
          leases.push(e);
        } else if (e.rule.action === 'reject') {
          throw new RateLimitedError(
            `Concurrency limit "${e.rule.name}" reached (${e.rule.params.max} in flight); retry shortly.`,
            { retryAfterMs: this.concurrencyRetryMs, limit: e.rule.name, kind: 'concurrency' },
          );
        } else {
          warnings.push({
            rule: e.rule.id,
            kind: 'concurrency',
            retryAfterMs: this.concurrencyRetryMs,
          });
        }
      }

      for (const e of rate) {
        if (e.rule.kind !== 'rate') continue;
        const res = await this.backend.consumeRate(e.rule, e.subjectId, e.points);
        if (res.ok) continue;
        if (e.rule.action === 'reject') {
          throw new RateLimitedError(
            `Rate limit "${e.rule.name}" exceeded; retry in ${res.retryAfterMs} ms.`,
            { retryAfterMs: res.retryAfterMs, limit: e.rule.name },
          );
        }
        warnings.push({ rule: e.rule.id, kind: 'rate', retryAfterMs: res.retryAfterMs });
      }

      for (const e of quota) {
        const window = periodWindow(e.rule.params.period, now, resolveZone(this.timeZone));
        const res = await this.backend.consumeQuota(e.rule, e.subjectId, e.points, window);
        const resetsAt = window.resetsAt.toISOString();
        if (!res.ok) {
          await this.backend.refundQuota(e.rule, e.subjectId, e.points, window);
          if (e.rule.action === 'reject') {
            throw new QuotaExceededError(
              `Quota "${e.rule.name}" is exhausted; it resets at ${resetsAt}.`,
              { resetsAt, quota: e.rule.name },
            );
          }
          warnings.push({ rule: e.rule.id, kind: 'quota', resetsAt });
          continue;
        }
        charges.push({ ...e, window });
        const fraction = res.remaining / e.rule.params.points;
        if (fraction < this.warnBelow && fraction < metaFraction) {
          metaFraction = fraction;
          meta = { [META_KEYS.limits]: { rule: e.rule.id, remaining: res.remaining, resetsAt } };
        }
      }
    } catch (error) {
      await release();
      await refund();
      throw error;
    }

    return { meta, warnings, release, refund };
  }

  readUsage(rule: Rule, subjectId: string): Promise<Usage> {
    return this.backend.usage(rule, subjectId, this.clock.now(), resolveZone(this.timeZone));
  }
}

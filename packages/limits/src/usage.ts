import type { PeriodWindow } from './period';
import type { ConcurrencyRule, QuotaRule, RateRule } from './rules';
import type { Usage } from './types';

/** The counter state a limiter reports for one key; empty when nothing was consumed yet. */
export type CounterState = { consumedPoints: number; msBeforeNext: number } | null | undefined;

/** Pure: usage of a rate rule from its counter. `limit` is the rule's size on this backend. */
export const rateUsage = (
  rule: RateRule,
  subjectId: string,
  limit: number,
  state: CounterState,
  now: Date,
): Usage => {
  const consumed = Math.min(state?.consumedPoints ?? 0, limit);
  return {
    ruleId: rule.id,
    kind: 'rate',
    subjectId,
    limit,
    consumed,
    remaining: limit - consumed,
    resetsAt: state ? new Date(now.getTime() + state.msBeforeNext).toISOString() : null,
  };
};

/** Pure: usage of a quota rule in the given period window. */
export const quotaUsage = (
  rule: QuotaRule,
  subjectId: string,
  limit: number,
  state: CounterState,
  window: PeriodWindow,
): Usage => {
  const consumed = Math.min(state?.consumedPoints ?? 0, limit);
  return {
    ruleId: rule.id,
    kind: 'quota',
    subjectId,
    limit,
    consumed,
    remaining: limit - consumed,
    resetsAt: window.resetsAt.toISOString(),
  };
};

/** Pure: usage of a concurrency rule from the number of live leases. */
export const concurrencyUsage = (
  rule: ConcurrencyRule,
  subjectId: string,
  limit: number,
  inFlight: number,
): Usage => ({
  ruleId: rule.id,
  kind: 'concurrency',
  subjectId,
  limit,
  consumed: inFlight,
  remaining: Math.max(0, limit - inFlight),
  resetsAt: null,
});

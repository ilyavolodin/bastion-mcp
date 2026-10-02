import { EngineLimiter, type TimeZoneSource } from './engine';
import type { OperationContext } from './match';
import { MemoryBackend } from './memory-backend';
import type { Rule } from './rules';
import {
  type Admission,
  type Clock,
  type Limiter,
  LimiterBackendError,
  systemClock,
  type Usage,
} from './types';

/** Metric name set to 1 while limits run from the local fallback (14.2, 15). */
export const DEGRADED_METRIC = 'bastion.limits.degraded';

export type ResilientOptions = {
  /** `BASTION_EXPECTED_WORKERS`: the fallback enforces `1/expectedWorkers` of each rule. */
  expectedWorkers: number;
  /** Receives 1 when the limiter degrades and 0 when Redis recovers (`bastion.limits.degraded`). */
  onDegraded?: (value: 0 | 1) => void;
  clock?: Clock;
  timeZone?: TimeZoneSource;
  /** Upper bound on a Redis-backed check before it counts as an outage. */
  redisTimeoutMs?: number;
  /** While degraded, Redis is probed at most this often. */
  probeIntervalMs?: number;
};

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LimiterBackendError('Limit store timed out')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wraps the Redis limiter. When Redis fails the call is admitted by a per-worker in-memory limiter at
 * `1/expectedWorkers` of each rule (fail open, 14.2, 21.3); Redis is probed periodically and the limiter
 * recovers by itself.
 */
export class ResilientLimiter implements Limiter {
  private readonly fallback: EngineLimiter;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly probeMs: number;
  private degradedFlag = false;
  private nextProbeAt = 0;

  constructor(
    private readonly primary: Limiter,
    private readonly options: ResilientOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.redisTimeoutMs ?? 250;
    this.probeMs = options.probeIntervalMs ?? 5000;
    this.fallback = new EngineLimiter(new MemoryBackend(options.expectedWorkers), {
      clock: this.clock,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    });
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  private setDegraded(value: boolean): void {
    if (this.degradedFlag === value) return;
    this.degradedFlag = value;
    this.options.onDegraded?.(value ? 1 : 0);
  }

  async check(op: OperationContext, rules: readonly Rule[], requestId: string): Promise<Admission> {
    const nowMs = this.clock.now().getTime();
    if (this.degradedFlag && nowMs < this.nextProbeAt) {
      return this.fallback.check(op, rules, requestId);
    }
    try {
      const admission = await withTimeout(this.primary.check(op, rules, requestId), this.timeoutMs);
      this.setDegraded(false);
      return admission;
    } catch (error) {
      if (!(error instanceof LimiterBackendError)) throw error;
      this.nextProbeAt = nowMs + this.probeMs;
      this.setDegraded(true);
      return this.fallback.check(op, rules, requestId);
    }
  }

  readUsage(rule: Rule, subjectId: string): Promise<Usage> {
    return this.primary.readUsage(rule, subjectId);
  }
}

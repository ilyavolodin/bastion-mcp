import { type Clock, systemClock } from './types';

/** stderr handling (8.7): 200 lines/s per instance, last 1,000 lines kept, sinks injected. */

export const STDERR_RATE_PER_SECOND = 200;
export const STDERR_TAIL_LINES = 1_000;

export type RateDecision = { emit: boolean; suppressedBefore: number };

/** Token bucket (capacity = rate): bursts up to `rate`, refilling continuously. */
export class StderrRateLimiter {
  private tokens: number;
  private last: number;
  private suppressed = 0;

  constructor(
    private readonly rate: number = STDERR_RATE_PER_SECOND,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = rate;
    this.last = clock.now();
  }

  take(): RateDecision {
    const now = this.clock.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) {
      this.suppressed += 1;
      return { emit: false, suppressedBefore: 0 };
    }
    this.tokens -= 1;
    const suppressedBefore = this.suppressed;
    this.suppressed = 0;
    return { emit: true, suppressedBefore };
  }
}

/** Ring buffer of the most recent lines for the UI and the failure detail (8.6). */
export class StderrTail {
  private readonly lines: string[] = [];
  constructor(private readonly capacity: number = STDERR_TAIL_LINES) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.shift();
  }

  tail(count: number = this.capacity): string[] {
    return count <= 0 ? [] : this.lines.slice(-count);
  }

  get size(): number {
    return this.lines.length;
  }
}

/** Written elsewhere to the Redis stream `logs:{instanceId}` (8.7). */
export interface StderrSink {
  write(entry: { instanceId: string; line: string; ts: number }): void | Promise<void>;
}

/** OTEL log record emitted by the worker as `bastion.sandbox.stderr`. */
export type StderrLogRecord = {
  name: 'bastion.sandbox.stderr';
  body: string;
  attributes: { 'bastion.instance.id': string; 'bastion.installation.id': string | null };
};
export type StderrLogger = (record: StderrLogRecord) => void;

/** Rate limits, tails, logs and streams the lines of one instance. */
export class StderrPipeline {
  readonly tail = new StderrTail();
  private readonly limiter: StderrRateLimiter;

  constructor(
    private readonly options: {
      instanceId: string;
      installationId: string | null;
      sink?: StderrSink;
      logger?: StderrLogger;
      clock?: Clock;
    },
  ) {
    this.limiter = new StderrRateLimiter(STDERR_RATE_PER_SECOND, options.clock ?? systemClock);
  }

  /** Returns false when the line was dropped by the rate limiter. */
  handle(line: string): boolean {
    const decision = this.limiter.take();
    if (!decision.emit) return false;
    const lines =
      decision.suppressedBefore > 0
        ? [`[bastion] ${decision.suppressedBefore} stderr lines suppressed (rate limit)`, line]
        : [line];
    const ts = (this.options.clock ?? systemClock).now();
    for (const entry of lines) {
      this.tail.push(entry);
      void this.options.sink?.write({ instanceId: this.options.instanceId, line: entry, ts });
      this.options.logger?.({
        name: 'bastion.sandbox.stderr',
        body: entry,
        attributes: {
          'bastion.instance.id': this.options.instanceId,
          'bastion.installation.id': this.options.installationId,
        },
      });
    }
    return true;
  }
}

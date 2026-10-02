/** Pure latency statistics for the load suite (tdd 23.4). No I/O. */

export type Summary = {
  count: number;
  errors: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

export type Percentile = 'p50' | 'p90' | 'p95' | 'p99';

/** Nearest-rank percentile of an unsorted sample (q in 0..100). NaN for an empty sample. */
export const percentile = (samples: readonly number[], q: number): number => {
  if (samples.length === 0) return Number.NaN;
  if (q < 0 || q > 100) throw new RangeError(`percentile out of range: ${q}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
};

/** Summarizes successful-call latencies in milliseconds; `errors` counts failed calls (no latency recorded). */
export const summarize = (latenciesMs: readonly number[], errors = 0): Summary => {
  const count = latenciesMs.length;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const at = (q: number): number => {
    if (count === 0) return Number.NaN;
    const rank = Math.max(1, Math.ceil((q / 100) * count));
    return sorted[Math.min(rank, count) - 1] as number;
  };
  return {
    count,
    errors,
    mean: count === 0 ? Number.NaN : latenciesMs.reduce((a, b) => a + b, 0) / count,
    p50: at(50),
    p90: at(90),
    p95: at(95),
    p99: at(99),
    max: count === 0 ? Number.NaN : (sorted[count - 1] as number),
  };
};

/** Latency Bastion adds at a percentile: via-gateway minus direct-to-upstream (23.4 "added p50/p99"). */
export const addedLatency = (via: Summary, direct: Summary, p: Percentile): number =>
  via[p] - direct[p];

/**
 * Fixed-size uniform reservoir (Algorithm R), so a one-hour run does not hold millions of samples.
 * `random` is injectable for tests.
 */
export class Reservoir {
  private readonly items: number[] = [];
  private seen = 0;

  constructor(
    private readonly capacity: number,
    private readonly random: () => number = Math.random,
  ) {
    if (capacity < 1) throw new RangeError('capacity must be at least 1');
  }

  add(value: number): void {
    this.seen += 1;
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return;
    }
    const slot = Math.floor(this.random() * this.seen);
    if (slot < this.capacity) this.items[slot] = value;
  }

  get total(): number {
    return this.seen;
  }

  values(): readonly number[] {
    return this.items;
  }
}

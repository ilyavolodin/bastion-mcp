/** A tiny reusable load harness (23.4): closed-loop workers, warm-up, percentiles. */
export type LatencyStats = {
  count: number;
  errors: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  /** Requests per second over the measured window. */
  rps: number;
};

export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
};

/** Runs `total` calls of `fn` with `concurrency` closed-loop workers; latencies are in milliseconds. */
export const measure = async (options: {
  concurrency: number;
  total: number;
  warmup?: number;
  fn: (index: number) => Promise<void>;
}): Promise<LatencyStats> => {
  const run = async (count: number, record: boolean): Promise<{ samples: number[]; errors: number; ms: number }> => {
    const samples: number[] = [];
    let errors = 0;
    let next = 0;
    const started = performance.now();
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= count) return;
        const t0 = performance.now();
        try {
          await options.fn(i);
          if (record) samples.push(performance.now() - t0);
        } catch {
          errors += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
    return { samples, errors, ms: performance.now() - started };
  };
  if ((options.warmup ?? 0) > 0) await run(options.warmup ?? 0, false);
  const { samples, errors, ms } = await run(options.total, true);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    errors,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
    mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    rps: (sorted.length / ms) * 1000,
  };
};

export const formatStats = (label: string, s: LatencyStats): string =>
  `${label}: n=${s.count} err=${s.errors} p50=${s.p50.toFixed(2)}ms p90=${s.p90.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms max=${s.max.toFixed(1)}ms rps=${s.rps.toFixed(0)}`;

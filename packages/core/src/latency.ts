/**
 * Latency histogram math of the call-log rollups (15.5): 24 fixed log-scale buckets from 1 ms to ~60 s, merging,
 * percentiles and the error-outcome rule. Shared by `@bastion-mcp/db` (SQL bucketing) and `@bastion-mcp/telemetry`.
 */

export const LATENCY_BUCKET_COUNT = 24;
const MAX_FINITE_MS = 60_000;

/** Inclusive upper bounds in ms: 23 log-spaced values from 1 to 60 000, then the overflow bucket. */
export const LATENCY_UPPER_BOUNDS_MS: readonly number[] = Object.freeze([
  ...Array.from({ length: LATENCY_BUCKET_COUNT - 1 }, (_, i) =>
    i === LATENCY_BUCKET_COUNT - 2
      ? MAX_FINITE_MS
      : Math.ceil(MAX_FINITE_MS ** (i / (LATENCY_BUCKET_COUNT - 2))),
  ),
  Number.POSITIVE_INFINITY,
]);

/** The 23 finite bounds, passed to SQL as `float8[]` to bucket `duration_ms` inside the database. */
export const FINITE_BOUNDS_MS: readonly number[] = LATENCY_UPPER_BOUNDS_MS.slice(0, -1);

export type LatencyBuckets = readonly number[];

export const emptyBuckets = (): number[] => new Array<number>(LATENCY_BUCKET_COUNT).fill(0);

/** Index of the first bucket whose upper bound is >= `ms`; values <= 1 ms and NaN land in bucket 0. */
export const latencyBucketIndex = (ms: number): number => {
  if (!(ms > 1)) return 0;
  for (let i = 0; i < LATENCY_UPPER_BOUNDS_MS.length; i++) {
    const bound = LATENCY_UPPER_BOUNDS_MS[i];
    if (bound !== undefined && ms <= bound) return i;
  }
  return LATENCY_BUCKET_COUNT - 1;
};

/** Element-wise sum; associative and commutative. */
export const mergeBuckets = (a: LatencyBuckets, b: LatencyBuckets): number[] => {
  const out = emptyBuckets();
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
};

/**
 * Percentile (`p` in [0, 1]) as the upper bound of the bucket holding that rank. The overflow bucket
 * reports 60 000. Returns `null` for an empty histogram. Monotonic in `p`.
 */
export const percentileFromBuckets = (buckets: LatencyBuckets, p: number): number | null => {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.max(1, Math.ceil(clamped * total));
  let seen = 0;
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) {
    seen += buckets[i] ?? 0;
    if (seen >= rank) return Math.min(LATENCY_UPPER_BOUNDS_MS[i] ?? MAX_FINITE_MS, MAX_FINITE_MS);
  }
  return MAX_FINITE_MS;
};

/** Outcomes that count as errors: everything except `ok` and `input_required` (15.5). */
export const isErrorOutcome = (outcome: string): boolean =>
  outcome !== 'ok' && outcome !== 'input_required';

/** The nil UUID: the unattributed key of org-scoped rows (ADR 0001, 2). */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

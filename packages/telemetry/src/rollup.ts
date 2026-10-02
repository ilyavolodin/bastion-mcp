/**
 * Call-log rollup math (15.5): 24 fixed log-scale latency buckets from 1 ms to ~60 s, merging, percentiles
 * and the per-minute aggregation. Unattributed keys use the nil UUID / empty string (ADR 0001, 2).
 */

export const LATENCY_BUCKET_COUNT = 24;
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_FINITE_MS = 60_000;

/**
 * Upper bounds (inclusive, ms): 23 log-spaced bounds 1 ms .. 60 000 ms, then `Infinity` for the overflow
 * bucket.
 */
export const bucketUpperBoundsMs: readonly number[] = Object.freeze([
  ...Array.from({ length: LATENCY_BUCKET_COUNT - 1 }, (_, i) =>
    i === LATENCY_BUCKET_COUNT - 2
      ? MAX_FINITE_MS
      : Math.ceil(MAX_FINITE_MS ** (i / (LATENCY_BUCKET_COUNT - 2))),
  ),
  Number.POSITIVE_INFINITY,
]);

export type LatencyBuckets = readonly number[];

export const emptyBuckets = (): number[] => new Array<number>(LATENCY_BUCKET_COUNT).fill(0);

/** Index of the first bucket whose upper bound is >= `ms`. Values <= 1 ms and NaN land in bucket 0. */
export const latencyBucketIndex = (ms: number): number => {
  if (!(ms > 1)) return 0;
  for (let i = 0; i < bucketUpperBoundsMs.length; i++) {
    const bound = bucketUpperBoundsMs[i];
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
    if (seen >= rank) return Math.min(bucketUpperBoundsMs[i] ?? MAX_FINITE_MS, MAX_FINITE_MS);
  }
  return MAX_FINITE_MS;
};

/** Outcomes that count toward `errorCount`: everything except `ok` and `input_required`. */
export const isErrorOutcome = (outcome: string): boolean =>
  outcome !== 'ok' && outcome !== 'input_required';

export interface RollupInputRow {
  ts: Date;
  installationId?: string | null | undefined;
  catalogEntryId?: string | null | undefined;
  itemName?: string | null | undefined;
  outcome: string;
  durationMs: number;
  bytesOut?: number | undefined;
}

export interface MinuteStats {
  /** Start of the minute (UTC). */
  bucket: Date;
  installationId: string;
  catalogEntryId: string;
  itemName: string;
  outcome: string;
  count: number;
  errorCount: number;
  bytesOut: number;
  latencyBuckets: number[];
}

const MINUTE_MS = 60_000;

export const minuteStart = (ts: Date): Date =>
  new Date(Math.floor(ts.getTime() / MINUTE_MS) * MINUTE_MS);

/** Aggregate rows keyed by (bucket minute, installationId, itemName, outcome). Output is sorted by key. */
export const rollupMinute = (rows: readonly RollupInputRow[]): MinuteStats[] => {
  const map = new Map<string, MinuteStats>();
  for (const row of rows) {
    const bucket = minuteStart(row.ts);
    const installationId = row.installationId ?? NIL_UUID;
    const itemName = row.itemName ?? '';
    const key = JSON.stringify([bucket.getTime(), installationId, itemName, row.outcome]);
    let stats = map.get(key);
    if (stats === undefined) {
      stats = {
        bucket,
        installationId,
        catalogEntryId: row.catalogEntryId ?? NIL_UUID,
        itemName,
        outcome: row.outcome,
        count: 0,
        errorCount: 0,
        bytesOut: 0,
        latencyBuckets: emptyBuckets(),
      };
      map.set(key, stats);
    }
    stats.count += 1;
    if (isErrorOutcome(row.outcome)) stats.errorCount += 1;
    stats.bytesOut += row.bytesOut ?? 0;
    const idx = latencyBucketIndex(row.durationMs);
    stats.latencyBuckets[idx] = (stats.latencyBuckets[idx] ?? 0) + 1;
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
};

/** Merge stats rows that share a key (used for minute -> hour -> day roll-ups). */
export const mergeStats = (a: MinuteStats, b: MinuteStats): MinuteStats => ({
  ...a,
  count: a.count + b.count,
  errorCount: a.errorCount + b.errorCount,
  bytesOut: a.bytesOut + b.bytesOut,
  latencyBuckets: mergeBuckets(a.latencyBuckets, b.latencyBuckets),
});

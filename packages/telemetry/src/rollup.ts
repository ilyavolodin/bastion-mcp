/**
 * Call-log rollup math (15.5): the per-minute aggregation over core's latency histogram (24 fixed log-scale buckets
 * from 1 ms to ~60 s). Unattributed keys use the nil UUID / empty string (ADR 0001, 2).
 */

import {
  emptyBuckets,
  isErrorOutcome,
  LATENCY_BUCKET_COUNT,
  LATENCY_UPPER_BOUNDS_MS,
  latencyBucketIndex,
  mergeBuckets,
  NIL_UUID,
  percentileFromBuckets,
} from '@bastion-mcp/core';

export type { LatencyBuckets } from '@bastion-mcp/core';

/** `bucketUpperBoundsMs` is the telemetry name of core's `LATENCY_UPPER_BOUNDS_MS`. */
export const bucketUpperBoundsMs = LATENCY_UPPER_BOUNDS_MS;

export {
  emptyBuckets,
  isErrorOutcome,
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  mergeBuckets,
  NIL_UUID,
  percentileFromBuckets,
};

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

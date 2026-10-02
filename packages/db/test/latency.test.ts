import { describe, expect, it } from 'vitest';
import {
  emptyBuckets,
  FINITE_BOUNDS_MS,
  isErrorOutcome,
  LATENCY_BUCKET_COUNT,
  LATENCY_UPPER_BOUNDS_MS,
  latencyBucketIndex,
  mergeBuckets,
  percentileFromBuckets,
} from '../src/latency';

describe('15.5 latency histogram (ported from @bastion-mcp/telemetry)', () => {
  it('keeps the 24 log-scale bounds identical to telemetry', () => {
    // Golden values from telemetry's `bucketUpperBoundsMs`; update both packages together.
    expect(FINITE_BOUNDS_MS).toEqual([
      1, 2, 3, 5, 8, 13, 21, 34, 55, 91, 149, 245, 404, 666, 1099, 1811, 2986, 4923, 8118, 13384,
      22069, 36389, 60000,
    ]);
    expect(LATENCY_UPPER_BOUNDS_MS).toHaveLength(LATENCY_BUCKET_COUNT);
    expect(LATENCY_UPPER_BOUNDS_MS[LATENCY_BUCKET_COUNT - 1]).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    [-5, 0],
    [0, 0],
    [1, 0],
    [1.5, 1],
    [2, 1],
    [3, 2],
    [60_000, 22],
    [60_001, 23],
    [Number.NaN, 0],
    [1e9, 23],
  ])('maps %s ms to bucket %s', (ms, index) => {
    expect(latencyBucketIndex(ms)).toBe(index);
  });

  it('merges element-wise and computes monotonic percentiles from bucket upper bounds', () => {
    const a = emptyBuckets();
    const b = emptyBuckets();
    a[2] = 5;
    b[2] = 5;
    b[10] = 10;
    const merged = mergeBuckets(a, b);
    expect(merged[2]).toBe(10);
    expect(merged[10]).toBe(10);
    expect(percentileFromBuckets(merged, 0.5)).toBe(3);
    expect(percentileFromBuckets(merged, 0.99)).toBe(149);
    expect(percentileFromBuckets(merged, 0)).toBe(3);
    expect(percentileFromBuckets(merged, 2)).toBe(149);
    expect(percentileFromBuckets(emptyBuckets(), 0.5)).toBeNull();
    const overflow = emptyBuckets();
    overflow[23] = 1;
    expect(percentileFromBuckets(overflow, 0.5)).toBe(60_000);
    expect(percentileFromBuckets([], 0.5)).toBeNull();
  });

  it('counts every outcome except ok and input_required as an error', () => {
    expect(isErrorOutcome('ok')).toBe(false);
    expect(isErrorOutcome('input_required')).toBe(false);
    for (const o of ['tool_error', 'error', 'blocked', 'denied', 'rate_limited']) {
      expect(isErrorOutcome(o)).toBe(true);
    }
  });
});

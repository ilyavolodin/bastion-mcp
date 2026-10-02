import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bucketUpperBoundsMs,
  emptyBuckets,
  isErrorOutcome,
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  mergeBuckets,
  mergeStats,
  minuteStart,
  NIL_UUID,
  percentileFromBuckets,
  rollupMinute,
} from '../src';

const bucketsArb = fc.array(fc.integer({ min: 0, max: 1000 }), {
  minLength: LATENCY_BUCKET_COUNT,
  maxLength: LATENCY_BUCKET_COUNT,
});

describe('15.5 latency buckets', () => {
  it('15.5 has 24 fixed log-scale buckets from 1 ms to 60 s plus an overflow bucket', () => {
    expect(bucketUpperBoundsMs).toHaveLength(24);
    expect(bucketUpperBoundsMs[0]).toBe(1);
    expect(bucketUpperBoundsMs[22]).toBe(60_000);
    expect(bucketUpperBoundsMs[23]).toBe(Number.POSITIVE_INFINITY);
    for (let i = 1; i < 24; i++) {
      expect(bucketUpperBoundsMs[i] ?? 0).toBeGreaterThan(bucketUpperBoundsMs[i - 1] ?? 0);
    }
  });

  it('15.5 maps a latency to the first bucket whose upper bound covers it', () => {
    expect(latencyBucketIndex(0)).toBe(0);
    expect(latencyBucketIndex(-5)).toBe(0);
    expect(latencyBucketIndex(Number.NaN)).toBe(0);
    expect(latencyBucketIndex(1)).toBe(0);
    expect(latencyBucketIndex(1.5)).toBe(1);
    expect(latencyBucketIndex(60_000)).toBe(22);
    expect(latencyBucketIndex(60_001)).toBe(23);
    expect(latencyBucketIndex(10 ** 9)).toBe(23);
  });

  it('15.5 bucket index is monotonic in latency', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200_000, noNaN: true }),
        fc.double({ min: 0, max: 200_000, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(latencyBucketIndex(lo)).toBeLessThanOrEqual(latencyBucketIndex(hi));
        },
      ),
    );
  });

  it('15.5 merging buckets is associative, commutative and has an identity', () => {
    fc.assert(
      fc.property(bucketsArb, bucketsArb, bucketsArb, (a, b, c) => {
        expect(mergeBuckets(mergeBuckets(a, b), c)).toEqual(mergeBuckets(a, mergeBuckets(b, c)));
        expect(mergeBuckets(a, b)).toEqual(mergeBuckets(b, a));
        expect(mergeBuckets(a, emptyBuckets())).toEqual(a);
      }),
    );
  });

  it('15.5 percentiles from buckets are monotonic in p', () => {
    fc.assert(
      fc.property(
        bucketsArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (buckets, p, q) => {
          const [lo, hi] = p <= q ? [p, q] : [q, p];
          const a = percentileFromBuckets(buckets, lo);
          const b = percentileFromBuckets(buckets, hi);
          if (a === null || b === null) {
            expect(a).toBe(b);
          } else {
            expect(a).toBeLessThanOrEqual(b);
          }
        },
      ),
    );
  });

  it('15.5 reads percentiles as the upper bound of the bucket holding the rank', () => {
    const buckets = emptyBuckets();
    buckets[0] = 90;
    buckets[10] = 9;
    buckets[23] = 1;
    expect(percentileFromBuckets(buckets, 0.5)).toBe(1);
    expect(percentileFromBuckets(buckets, 0.95)).toBe(bucketUpperBoundsMs[10]);
    expect(percentileFromBuckets(buckets, 1)).toBe(60_000);
    expect(percentileFromBuckets(buckets, -1)).toBe(1);
    expect(percentileFromBuckets(buckets, 7)).toBe(60_000);
    expect(percentileFromBuckets(emptyBuckets(), 0.5)).toBeNull();
  });

  it('15.5 merged percentile equals the percentile of the combined samples', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100_000, noNaN: true }), { minLength: 1 }),
        fc.array(fc.double({ min: 0, max: 100_000, noNaN: true }), { minLength: 1 }),
        (xs, ys) => {
          const hist = (v: number[]) => {
            const b = emptyBuckets();
            for (const x of v) b[latencyBucketIndex(x)] = (b[latencyBucketIndex(x)] ?? 0) + 1;
            return b;
          };
          expect(mergeBuckets(hist(xs), hist(ys))).toEqual(hist([...xs, ...ys]));
        },
      ),
    );
  });
});

describe('15.5 rollupMinute', () => {
  const t = (s: string) => new Date(`2026-05-01T10:${s}Z`);

  it('15.5 floors timestamps to the minute', () => {
    expect(minuteStart(t('15:42.123')).toISOString()).toBe('2026-05-01T10:15:00.000Z');
  });

  it('15.5 aggregates by (minute, installation, item, outcome)', () => {
    const inst = '11111111-1111-4111-8111-111111111111';
    const stats = rollupMinute([
      {
        ts: t('00:01'),
        installationId: inst,
        itemName: 'a',
        outcome: 'ok',
        durationMs: 5,
        bytesOut: 10,
      },
      {
        ts: t('00:59'),
        installationId: inst,
        itemName: 'a',
        outcome: 'ok',
        durationMs: 5,
        bytesOut: 5,
      },
      { ts: t('00:30'), installationId: inst, itemName: 'a', outcome: 'error', durationMs: 70_000 },
      { ts: t('01:00'), installationId: inst, itemName: 'a', outcome: 'ok', durationMs: 1 },
    ]);
    expect(stats).toHaveLength(3);
    const ok = stats.find((s) => s.outcome === 'ok' && s.bucket.getUTCMinutes() === 0);
    expect(ok).toMatchObject({ count: 2, errorCount: 0, bytesOut: 15 });
    expect(ok?.latencyBuckets[latencyBucketIndex(5)]).toBe(2);
    const err = stats.find((s) => s.outcome === 'error');
    expect(err).toMatchObject({ count: 1, errorCount: 1, bytesOut: 0 });
    expect(err?.latencyBuckets[23]).toBe(1);
  });

  it('15.5 uses the nil UUID and empty string for unattributed keys (ADR 0001 2)', () => {
    const [row] = rollupMinute([{ ts: t('00:00'), outcome: 'ok', durationMs: 1 }]);
    expect(row).toMatchObject({ installationId: NIL_UUID, catalogEntryId: NIL_UUID, itemName: '' });
    const [row2] = rollupMinute([
      {
        ts: t('00:00'),
        outcome: 'ok',
        durationMs: 1,
        installationId: null,
        itemName: null,
        catalogEntryId: null,
      },
    ]);
    expect(row2?.installationId).toBe(NIL_UUID);
  });

  it('15.5 counts every outcome except ok and input_required as an error', () => {
    expect(isErrorOutcome('ok')).toBe(false);
    expect(isErrorOutcome('input_required')).toBe(false);
    for (const o of ['tool_error', 'error', 'blocked', 'denied', 'rate_limited']) {
      expect(isErrorOutcome(o)).toBe(true);
    }
  });

  it('15.5 rolling up in any split gives the same totals as rolling up all rows', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sec: fc.integer({ min: 0, max: 59 }),
            outcome: fc.constantFrom('ok', 'error'),
            durationMs: fc.double({ min: 0, max: 100_000, noNaN: true }),
            bytesOut: fc.integer({ min: 0, max: 1000 }),
          }),
          { maxLength: 40 },
        ),
        fc.nat(40),
        (raw, cut) => {
          const rows = raw.map((r) => ({
            ts: new Date(Date.UTC(2026, 4, 1, 10, 0, r.sec)),
            outcome: r.outcome,
            durationMs: r.durationMs,
            bytesOut: r.bytesOut,
          }));
          const whole = rollupMinute(rows);
          const parts = [...rollupMinute(rows.slice(0, cut)), ...rollupMinute(rows.slice(cut))];
          const merged = new Map<string, ReturnType<typeof mergeStats>>();
          for (const p of parts) {
            const k = p.outcome;
            const prev = merged.get(k);
            merged.set(k, prev === undefined ? p : mergeStats(prev, p));
          }
          expect([...merged.values()].sort((a, b) => a.outcome.localeCompare(b.outcome))).toEqual(
            [...whole].sort((a, b) => a.outcome.localeCompare(b.outcome)),
          );
        },
      ),
    );
  });
});

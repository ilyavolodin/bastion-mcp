import { describe, expect, it } from 'vitest';
import { dueCount, pace } from '../src/pacing';
import { addedLatency, percentile, Reservoir, summarize } from '../src/stats';

describe('23.4 latency statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 99)).toBe(99);
    expect(percentile(samples, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });

  it('returns NaN for an empty sample and rejects out-of-range q', () => {
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  it('summarizes latencies and counts errors separately', () => {
    const s = summarize([1, 2, 3, 4, 100], 2);
    expect(s).toMatchObject({ count: 5, errors: 2, p50: 3, p99: 100, max: 100, mean: 22 });
    expect(summarize([]).p99).toBeNaN();
  });

  it('computes added latency as via minus direct at the same percentile', () => {
    const via = summarize([6, 7, 8, 30]);
    const direct = summarize([2, 2, 3, 5]);
    expect(addedLatency(via, direct, 'p50')).toBe(7 - 2);
    expect(addedLatency(via, direct, 'p99')).toBe(30 - 5);
  });

  it('keeps a bounded uniform reservoir', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const r = new Reservoir(100, random);
    for (let i = 0; i < 10_000; i += 1) r.add(i);
    expect(r.values()).toHaveLength(100);
    expect(r.total).toBe(10_000);
    const mean = r.values().reduce((a, b) => a + b, 0) / 100;
    expect(mean).toBeGreaterThan(3000);
    expect(mean).toBeLessThan(7000);
    expect(() => new Reservoir(0)).toThrow(RangeError);
  });
});

describe('23.4 open-loop pacing', () => {
  it('schedules requests by elapsed time, not by completion', () => {
    expect(dueCount(2000, 0)).toBe(0);
    expect(dueCount(2000, 1)).toBe(2);
    expect(dueCount(2000, 1000)).toBe(2000);
    expect(dueCount(0.5, 3000)).toBe(1);
  });

  it('starts exactly rate x duration requests with a fake clock and records errors', async () => {
    let t = 0;
    const result = await pace({
      rate: 100,
      durationSec: 2,
      maxInflight: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      fire: async (i) => {
        if (i % 10 === 0) throw new Error('boom');
        return 3;
      },
    });
    expect(result.started).toBe(200);
    expect(result.latenciesMs).toHaveLength(180);
    expect(result.errors).toBe(20);
    expect(result.skipped).toBe(0);
  });

  it('skips (and reports) requests above the in-flight cap instead of queueing them', async () => {
    let t = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const result = await pace({
      rate: 1000,
      durationSec: 1,
      maxInflight: 5,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (t >= 900) open();
      },
      fire: async () => {
        await gate;
        return 1;
      },
    });
    expect(result.started + result.skipped).toBe(1000);
    expect(result.started).toBeLessThan(1000);
    expect(result.skipped).toBeGreaterThan(800);
  });
});

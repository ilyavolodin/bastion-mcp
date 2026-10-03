import { describe, expect, it } from 'vitest';
import { pollUntil } from '../src/poll';
import { manualClock } from './fake-infra';

const harness = () => {
  const clock = manualClock();
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };
};

describe('pollUntil', () => {
  it('returns the first accepted value without sleeping', async () => {
    const h = harness();
    const out = await pollUntil(
      async () => 'ready',
      (v) => v === 'ready',
      { timeoutMs: 10_000, intervalMs: 1_000, clock: h.clock, sleep: h.sleep },
    );
    expect(out).toBe('ready');
    expect(h.sleeps).toEqual([]);
  });

  it('retries on the interval until the value is accepted', async () => {
    const h = harness();
    let calls = 0;
    const out = await pollUntil(
      async () => ++calls,
      (n) => n === 3,
      { timeoutMs: 10_000, intervalMs: 500, clock: h.clock, sleep: h.sleep },
    );
    expect(out).toBe(3);
    expect(h.sleeps).toEqual([500, 500]);
  });

  it('returns the last value once the deadline has passed', async () => {
    const h = harness();
    let calls = 0;
    const out = await pollUntil(
      async () => ++calls,
      () => false,
      { timeoutMs: 2_000, intervalMs: 1_000, clock: h.clock, sleep: h.sleep },
    );
    expect(out).toBe(3);
    expect(h.sleeps).toEqual([1_000, 1_000]);
  });

  it('makes exactly one attempt with a zero timeout', async () => {
    const h = harness();
    let calls = 0;
    await pollUntil(
      async () => ++calls,
      () => false,
      { timeoutMs: 0, intervalMs: 1_000, clock: h.clock, sleep: h.sleep },
    );
    expect(calls).toBe(1);
  });

  it('lets a failing attempt propagate', async () => {
    const h = harness();
    await expect(
      pollUntil(
        async () => {
          throw new Error('boom');
        },
        () => true,
        { timeoutMs: 1_000, intervalMs: 1, clock: h.clock, sleep: h.sleep },
      ),
    ).rejects.toThrow('boom');
  });
});

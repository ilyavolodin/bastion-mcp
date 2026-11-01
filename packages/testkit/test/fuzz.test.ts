import { describe, expect, it } from 'vitest';
import { FUZZ_CHUNK, fuzzRuns, inChunks } from '../src/fuzz';

describe('fuzz runs', () => {
  it('uses FUZZ_RUNS when it is a positive number, else the fallback', () => {
    expect(fuzzRuns(300, {})).toBe(300);
    expect(fuzzRuns(300, { FUZZ_RUNS: '500000' })).toBe(500_000);
    expect(fuzzRuns(300, { FUZZ_RUNS: '0' })).toBe(300);
    expect(fuzzRuns(300, { FUZZ_RUNS: '-5' })).toBe(300);
    expect(fuzzRuns(300, { FUZZ_RUNS: 'many' })).toBe(300);
  });

  it('splits the runs into chunks that add up to the total, the last one short', async () => {
    const seen: number[] = [];
    await inChunks(12_345, (runs) => seen.push(runs));
    expect(seen).toEqual([FUZZ_CHUNK, FUZZ_CHUNK, 2_345]);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(12_345);
  });

  it('runs nothing for zero runs, and lets the event loop turn between chunks', async () => {
    const none: number[] = [];
    await inChunks(0, (runs) => none.push(runs));
    expect(none).toEqual([]);

    let turned = false;
    setImmediate(() => {
      turned = true;
    });
    const seenTurned: boolean[] = [];
    await inChunks(30, (_runs) => seenTurned.push(turned), 10);
    expect(seenTurned).toEqual([false, true, true]);
  });
});

import { describe, expect, it } from 'vitest';
import { mapInBatches } from './batch';

describe('mapInBatches', () => {
  it('keeps the order of the items', async () => {
    const out = await mapInBatches([1, 2, 3, 4, 5], 2, async (n, i) => `${i}:${n * 2}`);
    expect(out).toEqual(['0:2', '1:4', '2:6', '3:8', '4:10']);
  });

  it('runs at most `size` calls at once', async () => {
    let running = 0;
    let peak = 0;
    await mapInBatches([...Array(10).keys()], 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });
    expect(peak).toBe(3);
  });

  it('starts the next batch only after the previous one settled', async () => {
    const log: string[] = [];
    await mapInBatches(['a', 'b', 'c'], 2, async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, x === 'a' ? 5 : 1));
      log.push(`end ${x}`);
    });
    expect(log.indexOf('start c')).toBeGreaterThan(log.indexOf('end a'));
  });

  it('handles an empty list and a size below one', async () => {
    expect(await mapInBatches([], 4, async (x) => x)).toEqual([]);
    expect(await mapInBatches([1, 2], 0, async (x) => x)).toEqual([1, 2]);
  });

  it('rejects when an item rejects', async () => {
    await expect(
      mapInBatches([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

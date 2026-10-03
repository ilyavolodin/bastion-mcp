import { describe, expect, it } from 'vitest';
import { dateClock } from '../src/clock';
import { MS, SECONDS } from '../src/constants';
import { isRecord, omitUndefined } from '../src/json';

describe('json helpers', () => {
  it('isRecord rejects null, arrays and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('omitUndefined drops only undefined values', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: null, d: 0 })).toEqual({ a: 1, c: null, d: 0 });
  });
});

describe('time constants and clock adapters', () => {
  it('units are consistent', () => {
    expect(MS.DAY).toBe(24 * MS.HOUR);
    expect(MS.WEEK).toBe(7 * MS.DAY);
    expect(SECONDS.DAY * 1000).toBe(MS.DAY);
  });

  it('dateClock wraps a numeric clock', () => {
    expect(
      dateClock({ now: () => 5 })
        .now()
        .getTime(),
    ).toBe(5);
  });
});

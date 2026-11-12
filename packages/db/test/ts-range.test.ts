import { describe, expect, it } from 'vitest';
import { tsRange } from '../src/repositories/support';

describe('15.5 ts range filter', () => {
  const from = new Date(1000);
  const to = new Date(2000);
  it('15.5 is empty without bounds, inclusive from and exclusive to', () => {
    expect(tsRange(undefined, undefined)).toEqual({});
    expect(tsRange(from, undefined)).toEqual({ ts: { gte: from } });
    expect(tsRange(undefined, to)).toEqual({ ts: { lt: to } });
    expect(tsRange(from, to)).toEqual({ ts: { gte: from, lt: to } });
  });
});

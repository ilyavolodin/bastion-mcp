import { describe, expect, it } from 'vitest';
import { asList, asRecord, asString, isRecord } from './json';

describe('json narrowing', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], [1], 'x', 1, true]) expect(isRecord(v)).toBe(false);
  });

  it('asRecord returns the object, and {} for arrays and scalars', () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
    expect(asRecord([1, 2])).toEqual({});
    expect(asRecord(null)).toEqual({});
    expect(asRecord('x')).toEqual({});
  });

  it('asList returns the array, and [] for anything else', () => {
    const l = [1];
    expect(asList(l)).toBe(l);
    expect(asList({ length: 1 })).toEqual([]);
    expect(asList(undefined)).toEqual([]);
  });

  it('asString returns the string, and "" for anything else', () => {
    expect(asString('a')).toBe('a');
    expect(asString(1)).toBe('');
    expect(asString(null)).toBe('');
  });
});

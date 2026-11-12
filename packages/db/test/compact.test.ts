import { describe, expect, it } from 'vitest';
import { compact } from '../src/repositories/support';

describe('compact', () => {
  it('17.1 drops keys whose value is undefined and keeps null, 0, empty string and false', () => {
    const input = {
      a: 1,
      b: undefined,
      c: null,
      d: 0,
      e: '',
      f: false,
      g: [],
      h: { i: undefined },
    };
    const out = compact<Record<string, unknown>>(input);
    expect(out).toEqual({ a: 1, c: null, d: 0, e: '', f: false, g: [], h: { i: undefined } });
    expect(Object.keys(out)).toEqual(['a', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect('b' in out).toBe(false);
  });

  it('17.1 returns a fresh object and leaves the input untouched', () => {
    const input = { a: 1, b: undefined };
    const out = compact<{ a: number }>(input);
    expect(out).not.toBe(input);
    expect('b' in input).toBe(true);
  });

  it('17.1 own enumerable keys only, in insertion order', () => {
    const proto = { inherited: 1 };
    const input = Object.assign(Object.create(proto) as object, { z: 1, y: undefined, x: 2 });
    expect(Object.keys(compact<object>(input))).toEqual(['z', 'x']);
  });
});

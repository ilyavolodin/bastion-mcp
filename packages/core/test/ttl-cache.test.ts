import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/ttl-cache';

const fakeClock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('TtlCache', () => {
  it('returns a value until it expires', () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>({ ttlMs: 100, clock });
    cache.set('a', 1);
    clock.advance(99);
    expect(cache.get('a')).toBe(1);
    clock.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest entry past max', () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, max: 2, clock: fakeClock() });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('delete and clear remove entries', () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, clock: fakeClock() });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

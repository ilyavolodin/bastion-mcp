import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './use-media-query';

type Listener = () => void;

/** A `matchMedia` whose queries the test can flip. */
const installMatchMedia = (initial: Record<string, boolean>) => {
  const state = { ...initial };
  const listeners = new Map<string, Set<Listener>>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return state[query] ?? false;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)?.add(l);
    },
    removeEventListener: (_: string, l: Listener) => listeners.get(query)?.delete(l),
  })) as unknown as typeof window.matchMedia;
  return {
    set: (query: string, value: boolean) => {
      state[query] = value;
      for (const l of listeners.get(query) ?? []) l();
    },
    count: (query: string) => listeners.get(query)?.size ?? 0,
  };
};

describe('useMediaQuery', () => {
  const original = window.matchMedia;
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    window.matchMedia = original;
  });

  it('starts with what the query says now and follows its changes', () => {
    const mq = installMatchMedia({ '(min-width: 1280px)': true });
    const { result } = renderHook(() => useMediaQuery('(min-width: 1280px)'));
    expect(result.current).toBe(true);
    act(() => mq.set('(min-width: 1280px)', false));
    expect(result.current).toBe(false);
  });

  it('re-subscribes when the query changes and lets go on unmount', () => {
    const mq = installMatchMedia({ a: false, b: true });
    const { result, rerender, unmount } = renderHook(({ q }) => useMediaQuery(q), {
      initialProps: { q: 'a' },
    });
    expect(result.current).toBe(false);
    rerender({ q: 'b' });
    expect(result.current).toBe(true);
    expect(mq.count('a')).toBe(0);
    expect(mq.count('b')).toBe(1);
    unmount();
    expect(mq.count('b')).toBe(0);
  });
});

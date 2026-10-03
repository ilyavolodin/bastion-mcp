import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounced } from './use-debounced-value';

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with the value and follows it once it stops changing', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 250), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'ab' });
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('ab');
  });

  it('restarts the wait on every change, so only the last value arrives', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 100), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(60));
    rerender({ v: 3 });
    act(() => vi.advanceTimersByTime(60));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(40));
    expect(result.current).toBe(3);
  });

  it('keeps the same object until the input changes', () => {
    const doc = { a: 1 };
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 10), {
      initialProps: { v: doc },
    });
    rerender({ v: doc });
    act(() => vi.advanceTimersByTime(20));
    expect(result.current).toBe(doc);
  });

  it('clears the timer on unmount', () => {
    const { rerender, unmount } = renderHook(({ v }) => useDebounced(v, 10), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

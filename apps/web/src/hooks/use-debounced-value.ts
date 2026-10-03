import { useEffect, useState } from 'react';

/** Typing into a list filter: refetch once per pause. */
export const DEBOUNCE_TYPING_MS = 250;
/** Typing into a server-side search that is heavier to answer (the registry has thousands of entries). */
export const DEBOUNCE_SEARCH_MS = 300;
/** Re-validating a document after the last keystroke. */
export const DEBOUNCE_VALIDATE_MS = 350;

/**
 * `value`, once it has stopped changing for `ms`. An effect that fires a request should run on the debounced value;
 * it should also skip while `debounced !== value` (the input changed again, or a form was just reset from props), so
 * a stale value is never sent: the effect then runs once the two agree.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

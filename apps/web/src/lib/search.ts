import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import type { z } from 'zod';

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Typed URL search state for a screen: parses the raw query with a zod schema (so a hand-edited URL
 * falls back to defaults) and writes patches back, dropping empty values to keep URLs short.
 */
export function useSearchState<S extends z.ZodType<Record<string, unknown>>>(schema: S) {
  const raw = useRouterState({ select: (s) => s.location.search }) as unknown as Record<
    string,
    unknown
  >;
  const navigate = useNavigate();
  const value = useMemo(() => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : (schema.parse({}) as z.infer<S>);
  }, [raw, schema]);
  const set = useCallback(
    (patch: Patch<z.infer<S>>, opts?: { replace?: boolean }) => {
      void navigate({
        to: '.',
        replace: opts?.replace ?? true,
        search: ((prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, ...patch };
          for (const k of Object.keys(next)) {
            if (next[k] === undefined || next[k] === '' || next[k] === null) delete next[k];
          }
          return next;
        }) as never,
      } as never);
    },
    [navigate],
  );
  return [value as z.infer<S>, set] as const;
}

/** Narrowing helpers for JSON read from the API (`unknown` documents such as server specs and overrides). */

/** True for a non-null, non-array object. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The object itself, or `{}` for anything else (arrays included). */
export const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** The array itself, or `[]` for anything else. */
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The string itself, or `''` for anything else. */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

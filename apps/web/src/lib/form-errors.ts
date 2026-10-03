import type { z } from 'zod';

/** The first message per field of a failed parse, keyed by the top-level field name. */
export const fieldErrors = (error: z.ZodError): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
};

/** Server-side field errors (`/slug`, `/serverSpec/url`) as a map keyed by the first path segment. */
export const serverFieldErrors = (
  errors: readonly { path: string; message: string }[],
): Record<string, string> =>
  Object.fromEntries(errors.map((e) => [e.path.replace(/^\//, '').split('/')[0] ?? '', e.message]));

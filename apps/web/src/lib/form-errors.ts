import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError } from '@/api/client';

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

/**
 * Puts the field errors of a 422 problem next to the inputs they name (`/claimMap/email` goes to the field called
 * `claimMap`, `/params/points` to `params`); an error that names no field of the form becomes a form-level error.
 */
export function applyServerErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
  fieldFor: (path: string) => Path<T> | undefined = (path) =>
    path.replace(/^\//, '').split('/')[0] as Path<T>,
): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  let unplaced: string | undefined;
  for (const e of error.errors) {
    const name = fieldFor(e.path);
    if (name && name in form.getValues())
      form.setError(name, { type: 'server', message: e.message });
    else unplaced = `${e.path ? `${e.path}: ` : ''}${e.message}`;
  }
  return unplaced ?? (error.errors.length === 0 ? error.message : undefined);
}

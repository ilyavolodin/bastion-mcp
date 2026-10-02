import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { ApiError } from '@/api/client';

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

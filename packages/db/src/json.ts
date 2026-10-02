import type { z } from 'zod';

/**
 * JSONB columns are validated by zod on write and on read (16.1). Repositories call these at the
 * boundary so an invalid document never enters or leaves the database unnoticed.
 */
export const readJson = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> =>
  schema.parse(value);

export const writeJson = <S extends z.ZodType>(schema: S, value: z.input<S>): z.output<S> =>
  schema.parse(value);

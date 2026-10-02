import { z } from 'zod';
import { pageSchema } from '../framework/conventions';

export const idSchema = z.string().min(1).max(128);
export const idParams = z.object({ id: idSchema });

/** A stored resource: open object with its id and `updatedAt` (the ETag version). */
export const itemSchema = z.looseObject({ id: z.string(), updatedAt: z.string() });
export type Item = z.infer<typeof itemSchema>;
export const itemPage = pageSchema(itemSchema);

export const okSchema = z.object({ ok: z.literal(true) });
export const emptySchema = z.null();

export const isoTime = z.string().datetime({ offset: true });

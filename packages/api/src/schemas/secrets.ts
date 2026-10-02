import { z } from 'zod';

export const secretScopeSchema = z.enum(['org', 'team', 'user']);

export const secretNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'letters, digits, dot, dash and underscore');

export const secretListQuery = z.object({
  scope: secretScopeSchema,
  ownerId: z.string().min(1).max(128).optional(),
});

export const secretParams = z.object({
  ownerId: z.string().min(1).max(128),
  name: secretNameSchema,
});

export const secretPutBody = z.object({
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
});

/** Metadata only: there is no field that could carry the value (22.3). */
export const secretMetaSchema = z.object({
  id: z.string(),
  scope: secretScopeSchema,
  ownerId: z.string().nullable(),
  name: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const secretListSchema = z.object({ items: z.array(secretMetaSchema) });

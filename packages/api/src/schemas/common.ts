import { AUTH_METHODS } from '@bastion-mcp/core';
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

/** Upper bounds shared by the request schemas. */
export const FIELD_MAX = { name: 200 } as const;
/** A display name or title: trimmed, non-empty, at most `FIELD_MAX.name` characters. */
export const nameSchema = z.string().trim().min(1).max(FIELD_MAX.name);

export const authMethodSchema = z.enum(AUTH_METHODS);
export const prefixModeSchema = z.enum(['always', 'onCollision']);
/** Override layer item kinds (the API spells templates `resourceTemplate`; core's `ITEM_KINDS` says `template`). */
export const OVERRIDE_KINDS = ['tool', 'prompt', 'resource', 'resourceTemplate'] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];
export const overrideKindSchema = z.enum(OVERRIDE_KINDS);
export const decisionSchema = z.enum(['allow', 'deny']);
/** Owner scope of a secret or an installation: the three that can own one. */
export const ownerScopeSchema = z.enum(['org', 'team', 'user']);

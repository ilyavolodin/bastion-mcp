import { DESKTOP_INSTALLATION_MODES, MARKETPLACE_ITEM_POLICIES } from '@bastion-mcp/core';
import { ROLLOUT_CLIENTS } from '@bastion-mcp/plugins';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';

const atLeastOne = (v: object) => Object.keys(v).length > 0;

export const audienceSchema = z.object({
  org: z.boolean().default(false),
  teamIds: z.array(z.string().min(1)).default([]),
  userIds: z.array(z.string().min(1)).default([]),
});

export const marketplaceCreateSchema = z.object({
  slug: z.string().min(1).max(63),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  /** Null: an org-owned marketplace (admins only); a team id: that team's managers administer it. */
  ownerTeamId: z.string().min(1).nullable().default(null),
  audience: audienceSchema.default({ org: false, teamIds: [], userIds: [] }),
  desktopInstallation: z.enum(DESKTOP_INSTALLATION_MODES).default('available'),
});

export const marketplacePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    audience: audienceSchema,
    desktopInstallation: z.enum(DESKTOP_INSTALLATION_MODES),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const itemParams = z.object({ id: z.string().min(1), entryId: z.string().min(1) });

export const itemBodySchema = z.object({
  policy: z.enum(MARKETPLACE_ITEM_POLICIES).default('available'),
  pinnedVersionId: z.string().min(1).nullable().default(null),
  position: z.number().int().min(0).max(100000).optional(),
});

export const releaseParams = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().min(1),
});

export const releaseSchema = z.looseObject({
  seq: z.number().int(),
  gitCommit: z.string(),
  releaseTime: z.string(),
  promoted: z.boolean(),
});

export const mirrorBodySchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  repo: z.string().min(1).max(512),
  branch: z.string().min(1).max(255).default('main'),
  credentialSecretId: z.string().min(1),
});

export const mirrorViewSchema = z.object({
  mirror: z
    .object({
      provider: z.enum(['github', 'gitlab']),
      repo: z.string(),
      branch: z.string(),
      credentialSecretId: z.string(),
    })
    .nullable(),
  status: z.looseObject({ status: z.string() }).nullable(),
  updatedAt: z.string(),
});

export const rolloutQuery = z.object({ client: z.enum(ROLLOUT_CLIENTS) });
export const usageQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
export const marketplaceListQuery = listQuerySchema;

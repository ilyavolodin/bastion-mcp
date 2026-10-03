import { REGISTRY_TRUST_LEVELS, registryPolicySchema } from '@bastion-mcp/registry';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';

const atLeastOne = (v: object) => Object.keys(v).length > 0;

export const registrySourceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(2048),
  /** Name of the secret holding the registry credential; the value never passes through the API. */
  authSecretId: z.string().min(1).max(256).nullable().default(null),
  authHeaderName: z.string().min(1).max(128).nullable().default(null),
  trust: z.enum(REGISTRY_TRUST_LEVELS).default('community'),
  enabled: z.boolean().default(true),
  syncIntervalS: z
    .number()
    .int()
    .min(60)
    .max(7 * 86400)
    .default(3600),
});

export const registrySourcePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    baseUrl: z.string().url().max(2048),
    authSecretId: z.string().min(1).max(256).nullable(),
    authHeaderName: z.string().min(1).max(128).nullable(),
    trust: z.enum(REGISTRY_TRUST_LEVELS),
    enabled: z.boolean(),
    syncIntervalS: z
      .number()
      .int()
      .min(60)
      .max(7 * 86400),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const syncBodySchema = z.object({ full: z.boolean().default(false) });
export const syncResultSchema = z.looseObject({
  ok: z.boolean(),
  stats: z.looseObject({}),
  deletedNames: z.array(z.string()),
  deprecatedNames: z.array(z.string()),
});

export const registryPolicyBodySchema = registryPolicySchema;
export const registryPolicyView = z.object({
  sourceId: z.string(),
  policy: registryPolicySchema,
  updatedAt: z.string().nullable(),
});

export const serverSearchQuery = listQuerySchema.omit({ sort: true }).extend({
  sourceId: z.string().min(1).optional(),
  includeDeleted: z.stringbool().optional(),
  /** Rows of disabled sources are hidden unless this is true. */
  includeDisabled: z.stringbool().optional(),
  /** Newest version of each server only (default true). */
  latestOnly: z.stringbool().optional(),
  runtime: z.enum(['remote', 'npm', 'pypi']).optional(),
});

export const serverParams = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
});

export const registryServerSummary = z
  .looseObject({
    sourceId: z.string(),
    /** Provenance: the source this row was mirrored from. */
    sourceName: z.string().optional(),
    trust: z.enum(['official', 'internal', 'community']).optional(),
    sourceEnabled: z.boolean().optional(),
    name: z.string(),
    version: z.string(),
    status: z.string(),
    isLatest: z.boolean(),
    title: z.string().optional(),
    description: z.string(),
    publishedAt: z.string().nullable().optional(),
    runtimes: z.array(z.string()),
    /** Whether the source policy shows this server to members (Admins and Auditors see every server). */
    visibleToMembers: z.boolean().optional(),
  })
  .meta({ id: 'RegistryServer' });

export const registryServerDetail = z
  .looseObject({
    ...registryServerSummary.shape,
    serverJson: z.looseObject({}),
    install: z.looseObject({
      installable: z.boolean(),
      /** What the source policy decides for the caller: install now, ask for approval, catalog only, or deny. */
      decision: z.string().optional(),
      reasons: z.array(z.string()),
      runtime: z.string().optional(),
      risk: z.string().optional(),
      warnings: z.array(z.string()).optional(),
    }),
  })
  .meta({ id: 'RegistryServerDetail' });

export const installBodySchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  prefer: z.enum(['remote', 'package']).optional(),
  justification: z.string().max(2000).optional(),
});

/** `installed` (201) carries the new entry and installation; `needs-request` (202) only the reasons. */
export const installResultSchema = z
  .looseObject({
    decision: z.enum(['installed', 'needs-request']),
    reasons: z.array(z.string()),
    entryId: z.string().optional(),
    installationId: z.string().optional(),
  })
  .meta({ id: 'RegistryInstallResult' });

export const requestListQuery = listQuerySchema
  .omit({ sort: true, q: true })
  .extend({ status: z.enum(['open', 'approved', 'rejected', 'cancelled']).optional() });

export const requestCreateSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  justification: z.string().trim().min(1).max(2000),
});

export const requestRejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

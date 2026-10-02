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

export const serverSearchQuery = listQuerySchema
  .omit({ sort: true })
  .extend({ sourceId: z.string().min(1).optional(), includeDeleted: z.stringbool().optional() });

export const serverParams = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
});

export const registryServerSummary = z.looseObject({
  sourceId: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  isLatest: z.boolean(),
  description: z.string(),
  runtimes: z.array(z.string()),
});

export const registryServerDetail = registryServerSummary.extend({
  serverJson: z.looseObject({}),
  install: z.looseObject({
    installable: z.boolean(),
    decision: z.string().optional(),
    reasons: z.array(z.string()),
  }),
});

export const installBodySchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  prefer: z.enum(['remote', 'package']).optional(),
  justification: z.string().max(2000).optional(),
});

export const installResultSchema = z.looseObject({
  decision: z.enum(['installed', 'needs-request']),
  reasons: z.array(z.string()),
});

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

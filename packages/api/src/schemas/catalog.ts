import {
  CATALOG_KINDS,
  CATALOG_STATUSES,
  DRIFT_POLICIES,
  RISK_LEVELS,
  serverSpecSchema,
  USER_OVERRIDE_LEVELS,
} from '@bastion-mcp/core';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';

export const visibilityBodySchema = z.object({
  org: z.boolean().default(false),
  teamIds: z.array(z.string().min(1)).default([]),
  userIds: z.array(z.string().min(1)).default([]),
});

const slugSchema = z.string().min(1).max(63);
const atLeastOne = (v: object) => Object.keys(v).length > 0;

export const entryCreateSchema = z.object({
  slug: slugSchema,
  kind: z.enum(CATALOG_KINDS).default('mcp_server'),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
  /** Team that owns the entry; absent means the organization owns it. */
  ownerTeamId: z.string().min(1).nullable().optional(),
  visibility: visibilityBodySchema.default({ org: false, teamIds: [], userIds: [] }),
  risk: z.enum(RISK_LEVELS).default('medium'),
  userOverrides: z.enum(USER_OVERRIDE_LEVELS).default('cosmetic'),
  onDrift: z.enum(DRIFT_POLICIES).default('hideChanged'),
  autoUpgrade: z.boolean().default(true),
});

export const entryPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    description: z.string().max(4000),
    tags: z.array(z.string().min(1).max(64)).max(32),
    visibility: visibilityBodySchema,
    risk: z.enum(RISK_LEVELS),
    userOverrides: z.enum(USER_OVERRIDE_LEVELS),
    onDrift: z.enum(DRIFT_POLICIES),
    autoUpgrade: z.boolean(),
    status: z.enum(['deprecated', 'archived']),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const entryListQuery = listQuerySchema.extend({
  kind: z.enum(CATALOG_KINDS).optional(),
  status: z.enum(CATALOG_STATUSES).optional(),
  ownerTeamId: z.string().min(1).optional(),
});

export const storeListQuery = listQuerySchema.extend({
  kind: z.enum(CATALOG_KINDS).optional(),
});

/** What the installer fills in (11.4): plain variables and per-user secrets, as `deriveInstallForm` produces them. */
export const installFormVariable = z.looseObject({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  choices: z.array(z.string()).optional(),
});
export const installFormSecret = z.looseObject({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
});
export const installFormSchema = z.object({
  variables: z.array(installFormVariable).default([]),
  secrets: z.array(installFormSecret).default([]),
});

export const versionCreateSchema = z.object({
  label: z.string().trim().min(1).max(64),
  /** Absent for skills and plugins, whose content is a file tree. */
  serverSpec: serverSpecSchema.nullable().default(null),
  installForm: installFormSchema.default({ variables: [], secrets: [] }),
  changelog: z.string().max(10000).nullable().default(null),
});

/** `PATCH /catalog/{id}/versions/{vid}`: any subset of the draft's fields. */
export const versionPatchSchema = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  serverSpec: serverSpecSchema.nullable().optional(),
  installForm: installFormSchema.optional(),
  changelog: z.string().max(10000).nullable().optional(),
});

/** Bodies of actions whose every field is optional: a missing or null body means `{}`. */
const optionalBody = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value): z.output<T> | Record<string, never> => value ?? {});

export const publishBodySchema = optionalBody(
  z.object({
    /** Who may see the entry once published; defaults to the entry's current visibility. */
    visibility: visibilityBodySchema.optional(),
  }),
);

/**
 * `POST /catalog/{id}/versions/{vid}/test`: values for the variables that have no default, so a test of a server that
 * needs them (a database URL, a region) can start. They live on the hidden test installation only (11.3).
 */
export const testStartBodySchema = optionalBody(
  z.object({
    variables: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
  }),
);

export const approveBodySchema = optionalBody(
  z.object({
    note: z.string().max(2000).optional(),
    /** The digest the reviewer saw; the approval fails when the content changed since (25.2). */
    reviewedDiffSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
);

export const importBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('server_json'),
    serverJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
    prefer: z.enum(['remote', 'package']).optional(),
  }),
  z.object({
    kind: z.literal('client_config'),
    snippet: z.record(z.string(), z.unknown()),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('registry'),
    sourceId: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  z.object({ kind: z.literal('zip'), contentBase64: z.string().min(1) }),
  z.object({ kind: z.literal('git'), url: z.string().url(), ref: z.string().min(1).optional() }),
]);
export type ImportBody = z.infer<typeof importBodySchema>;

export const importEnvelopeSchema = z.object({
  /** Imports create a draft entry; the owner decides the Cedar resource (team or org). */
  ownerTeamId: z.string().min(1).nullable().optional(),
  visibility: visibilityBodySchema.optional(),
  slug: slugSchema.optional(),
  source: importBodySchema,
});

export const fileBodySchema = z.object({
  contentBase64: z.string(),
  mode: z.enum(['file', 'executable']).default('file'),
});

export const fileParams = z.object({
  id: z.string().min(1),
  vid: z.string().min(1),
  path: z.string().min(1).max(1024),
});

export const versionParams = z.object({ id: z.string().min(1), vid: z.string().min(1) });
export const slugParams = z.object({ slug: z.string().min(1).max(128) });

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https URL');

export const pluginSourceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  gitUrl: httpsUrl,
  ref: z.string().min(1).max(255).default('main'),
  path: z.string().min(1).max(1024).nullable().default(null),
  authSecretId: z.string().min(1).nullable().default(null),
  tracked: z.boolean().default(true),
});

export const pluginSourcePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    gitUrl: httpsUrl,
    ref: z.string().min(1).max(255),
    path: z.string().min(1).max(1024).nullable(),
    authSecretId: z.string().min(1).nullable(),
    tracked: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

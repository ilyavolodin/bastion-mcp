import {
  AUTO_INSTALL_MODES,
  AUTO_INSTALL_SCOPES,
  INSTALLATION_STATUSES,
  ORG_ROLES,
  serverSpecSchema,
} from '@bastion-mcp/core';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import { CLIENT_KINDS } from '../services/client-config';

const atLeastOne = (v: object) => Object.keys(v).length > 0;
const slug = z.string().min(2).max(40);
const variables = z.record(z.string().min(1), z.string().max(4096));

// --- installations -----------------------------------------------------------------------------------

export const installationCreateSchema = z
  .object({
    /** Install a catalog entry (default: its current published version). */
    catalogEntryId: z.string().min(1).optional(),
    catalogVersionId: z.string().min(1).optional(),
    /** Or a personal installation from a spec (11.4). */
    personalSpec: serverSpecSchema.optional(),
    ownerType: z.enum(['user', 'team']).default('user'),
    /** Required when `ownerType` is `team`. */
    teamId: z.string().min(1).optional(),
    slug: slug.optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    toolPrefix: z.string().min(1).max(40).optional(),
    variables: variables.default({}),
    pinnedVersion: z.boolean().default(false),
  })
  .refine((v) => (v.catalogEntryId === undefined) !== (v.personalSpec === undefined), {
    message: 'give exactly one of catalogEntryId and personalSpec',
  })
  .refine((v) => v.ownerType !== 'team' || v.teamId !== undefined, {
    message: 'teamId is required for team installations',
    path: ['teamId'],
  })
  .refine((v) => v.ownerType !== 'team' || v.catalogEntryId !== undefined, {
    message: 'team installations come from a catalog entry',
    path: ['catalogEntryId'],
  });

export const installationPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    toolPrefix: z.string().min(1).max(40),
    variables,
    catalogVersionId: z.string().min(1),
    pinnedVersion: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const installationListQuery = listQuerySchema.extend({
  status: z.enum(INSTALLATION_STATUSES).optional(),
  catalogEntryId: z.string().min(1).optional(),
});

export const secretNameParams = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
});
export const secretPutSchema = z.object({ value: z.string().min(1).max(65_536) });
export const secretMetaSchema = z.object({
  name: z.string(),
  scope: z.enum(['org', 'team', 'user']),
  version: z.number().int(),
  updatedAt: z.string(),
});

export const tryBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool'),
    name: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('prompt'),
    name: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ kind: z.literal('resource'), uri: z.string().min(1).max(4096) }),
]);
export const tryResultSchema = z.object({
  result: z.unknown(),
  isError: z.boolean(),
  durationMs: z.number(),
  callId: z.string().nullable(),
});

export const connectBodySchema = z.object({ returnTo: z.string().max(2048).optional() });
export const connectResultSchema = z.object({ authorizationUrl: z.string().url() });

export const egressQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const logsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(1000).default(200),
  /** `false` sends the tail and ends the stream instead of following new lines. */
  follow: z.stringbool().default(true),
});

export const definitionsSchema = z.object({
  items: z.array(z.looseObject({})),
  meta: z.array(z.looseObject({})),
  degraded: z.array(z.looseObject({})),
  needsAuth: z.array(z.looseObject({})),
  warnings: z.array(z.looseObject({})),
  instructions: z.string().optional(),
});

// --- endpoints ---------------------------------------------------------------------------------------

export const endpointCreateSchema = z.object({
  slug,
  displayName: z.string().trim().min(1).max(200),
  installationIds: z.array(z.string().min(1)).max(50).default([]),
  prefixMode: z.enum(['always', 'onCollision']).default('always'),
  instructions: z.string().max(8000).optional(),
});
export const endpointPatchSchema = z
  .object({
    slug,
    displayName: z.string().trim().min(1).max(200),
    installationIds: z.array(z.string().min(1)).max(50),
    prefixMode: z.enum(['always', 'onCollision']),
    instructions: z.string().max(8000).nullable(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');
export const clientConfigQuery = z.object({
  client: z.enum(CLIENT_KINDS),
  auth: z.enum(['oauth', 'pat']).default('oauth'),
});
export const clientConfigSchema = z.object({
  client: z.enum(CLIENT_KINDS),
  url: z.string(),
  name: z.string(),
  auth: z.enum(['oauth', 'pat']),
  file: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  command: z.string().optional(),
  instructions: z.array(z.string()),
});

// --- overrides ---------------------------------------------------------------------------------------

export const overridesDocSchema = z.record(z.string(), z.unknown());
export const overridesViewSchema = z.object({
  doc: overridesDocSchema,
  updatedAt: z.string(),
  /** The entry's `userOverrides` level that bounds the installation layer (12.1). */
  userOverrides: z.enum(['none', 'cosmetic', 'full']).optional(),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export const catalogVersionParams = z.object({ id: z.string().min(1), vid: z.string().min(1) });

const upstreamSchema = z.object({
  instructions: z.string().optional(),
  tools: z
    .array(z.looseObject({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) }))
    .optional(),
  prompts: z.array(z.looseObject({ name: z.string() })).optional(),
  resources: z.array(z.looseObject({ uri: z.string(), name: z.string() })).optional(),
  resourceTemplates: z
    .array(z.looseObject({ uriTemplate: z.string(), name: z.string() }))
    .optional(),
});
export const previewBodySchema = z
  .object({
    /** The unsaved document. */
    doc: overridesDocSchema,
    layer: z.enum(['catalog', 'installation']).default('installation'),
    /** Loads upstream definitions and the other layer from this installation. */
    installationId: z.string().min(1).optional(),
    /** Or supply the upstream definitions inline. */
    upstream: upstreamSchema.optional(),
  })
  .refine((v) => v.installationId !== undefined || v.upstream !== undefined, {
    message: 'give installationId or upstream',
  });
export const previewResultSchema = z.object({
  final: z.looseObject({}),
  diff: z.array(z.looseObject({})),
  instructions: z.looseObject({}).optional(),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
});

// --- drift -------------------------------------------------------------------------------------------

export const driftListQuery = listQuerySchema.extend({
  status: z.enum(['open', 'approved', 'rejected']).optional(),
  installationId: z.string().min(1).optional(),
  catalogVersionId: z.string().min(1).optional(),
});
export const driftRejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export const driftApproveSchema = z.object({ note: z.string().max(2000).optional() }).default({});

// --- auto-install ------------------------------------------------------------------------------------

export const autoInstallTargetSchema = z
  .object({
    all: z.boolean().optional(),
    teamIds: z.array(z.string().min(1)).max(200).optional(),
    roles: z
      .array(z.enum([...ORG_ROLES, 'manager']))
      .max(8)
      .optional(),
    idpGroups: z.array(z.string().min(1).max(256)).max(200).optional(),
  })
  .refine(
    (t) =>
      t.all === true ||
      (t.teamIds?.length ?? 0) + (t.roles?.length ?? 0) + (t.idpGroups?.length ?? 0) > 0,
    { message: 'the target must name all users, teams, roles or IdP groups' },
  );
export type AutoInstallTarget = z.infer<typeof autoInstallTargetSchema>;

export const autoInstallCreateSchema = z.object({
  catalogEntryId: z.string().min(1),
  target: autoInstallTargetSchema,
  mode: z.enum(AUTO_INSTALL_MODES).default('default'),
  scope: z.enum(AUTO_INSTALL_SCOPES).default('user'),
  applyToExisting: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export const autoInstallPatchSchema = z
  .object({
    target: autoInstallTargetSchema,
    mode: z.enum(AUTO_INSTALL_MODES),
    scope: z.enum(AUTO_INSTALL_SCOPES),
    applyToExisting: z.boolean(),
    enabled: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');
export const autoInstallPreviewBody = z
  .object({
    target: autoInstallTargetSchema,
    mode: z.enum(AUTO_INSTALL_MODES),
    scope: z.enum(AUTO_INSTALL_SCOPES),
    applyToExisting: z.boolean(),
  })
  .partial()
  .default({});
export const autoInstallPreviewSchema = z.object({
  summary: z.string(),
  users: z.number().int(),
  teams: z.number().int(),
  willInstall: z.number().int(),
  alreadyInstalled: z.number().int(),
  skippedRemoved: z.number().int(),
  mustConnect: z.number().int(),
  byTeam: z.array(
    z.object({ teamId: z.string(), slug: z.string().nullable(), users: z.number().int() }),
  ),
  sample: z.array(z.object({ userId: z.string(), displayName: z.string() })),
});

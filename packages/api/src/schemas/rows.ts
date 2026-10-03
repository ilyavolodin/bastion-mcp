/**
 * Response schemas of the stored resources (17.2): what `GET`/`POST`/`PATCH` of every collection returns. They
 * describe the rows of `ResourceStore` (`apps/server/src/adapters/api/store`): one field per Prisma column in
 * camelCase, `DateTime` as ISO 8601 strings, `Bytes` as hex, nullable columns as `null`, minus the columns the
 * store hides. Every schema is registered under its name, so the OpenAPI document carries it as
 * `components.schemas.<Name>` and `@bastion-mcp/api-client` exposes a precise type for it.
 *
 * Rows stay open objects (`looseObject`): columns added later pass through without breaking older clients.
 */
import {
  AUTO_INSTALL_MODES,
  AUTO_INSTALL_SCOPES,
  CALL_OUTCOMES,
  CATALOG_KINDS,
  CATALOG_STATUSES,
  CATALOG_VERSION_STATUSES,
  DESKTOP_INSTALLATION_MODES,
  DRIFT_POLICIES,
  FILE_CLASSIFICATIONS,
  FILE_MODES,
  INSTALLATION_STATUSES,
  ITEM_KINDS,
  LIMIT_KINDS,
  MARKETPLACE_ITEM_POLICIES,
  MEMBERSHIP_SOURCES,
  ORG_ROLES,
  OWNER_TYPES,
  POLICY_EFFECTS,
  REQUEST_STATUSES,
  REVIEW_STATUSES,
  RISK_LEVELS,
  TEAM_ROLES,
  USER_OVERRIDE_LEVELS,
  USER_STATUSES,
} from '@bastion-mcp/core';
import { guardProfileSchema } from '@bastion-mcp/guards';
import { RuleSchema } from '@bastion-mcp/limits';
import { toolRuleRowSchema } from '@bastion-mcp/policy';
import { z } from 'zod';
import { pageSchema } from '../framework/conventions';
import type { Page, Row } from '../ports/store';
import { installFormSchema } from './catalog';
import { autoInstallTargetSchema } from './installations';
import { mirrorStateSchema, mirrorTargetSchema } from './marketplaces';
import { mapsToSchema } from './users';

/** A named row schema: open object with the given columns, registered as an OpenAPI component. */
const row = <S extends z.ZodRawShape>(id: string, shape: S) =>
  z.looseObject({ id: z.string(), updatedAt: z.string(), ...shape }).meta({ id });

const iso = z.string();
const isoOrNull = z.string().nullable();
const json = z.record(z.string(), z.unknown());

const visibility = z.object({
  org: z.boolean(),
  teamIds: z.array(z.string()),
  userIds: z.array(z.string()),
});

// --- users, teams, identity -------------------------------------------------------------------------------------

export const userRow = row('User', {
  email: z.string(),
  displayName: z.string(),
  idpConnectionId: z.string().nullable(),
  externalSubject: z.string().nullable(),
  scimExternalId: z.string().nullable(),
  orgRole: z.enum(ORG_ROLES),
  status: z.enum(USER_STATUSES),
  catalogPublishOrgWide: z.boolean(),
  lastLoginAt: isoOrNull,
  createdAt: iso,
});

export const teamRow = row('Team', {
  slug: z.string(),
  displayName: z.string(),
  idpGroup: z.string().nullable(),
  createdAt: iso,
});

export const teamMemberRow = row('TeamMember', {
  teamId: z.string(),
  userId: z.string(),
  role: z.enum(TEAM_ROLES),
  source: z.enum(MEMBERSHIP_SOURCES),
  createdAt: iso,
});

export const teamDetailRow = row('TeamDetail', {
  slug: z.string(),
  displayName: z.string(),
  idpGroup: z.string().nullable(),
  createdAt: iso,
  members: z.array(teamMemberRow),
});

export const roleMappingRuleRow = row('RoleMappingRule', {
  idpConnectionId: z.string().nullable(),
  groupPattern: z.string(),
  mapsTo: mapsToSchema,
  priority: z.number().int(),
  createdAt: iso,
});

export const serviceAccountRow = row('ServiceAccount', {
  teamId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'disabled']),
  oauthClientId: z.string().nullable(),
  authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
  createdAt: iso,
});

export const serviceAccountCreatedRow = z
  .looseObject({
    ...serviceAccountRow.shape,
    clientId: z.string(),
    authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
    clientSecret: z.string().optional(),
  })
  .meta({ id: 'ServiceAccountCreated' });

export const idpConnectionRow = row('IdpConnection', {
  name: z.string(),
  issuer: z.string(),
  discoveryUrl: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  claimMap: z.looseObject({
    email: z.string().optional(),
    name: z.string().optional(),
    groups: z.string().optional(),
    sub: z.string().optional(),
  }),
  emailDomains: z.array(z.string()),
  storeRefreshToken: z.boolean(),
  apiScope: z.string().nullable(),
  enterpriseManagedAuth: z.boolean(),
  enabled: z.boolean(),
  createdAt: iso,
});

export const scimTokenRow = row('ScimToken', {
  name: z.string(),
  createdBy: z.string(),
  expiresAt: isoOrNull,
  revokedAt: isoOrNull,
  createdAt: iso,
});

export const scimTokenCreatedRow = z
  .looseObject({ ...scimTokenRow.shape, token: z.string() })
  .meta({ id: 'ScimTokenCreated' });

export const oauthClientRow = row('OAuthClientPolicy', {
  clientId: z.string(),
  preApproved: z.boolean(),
  blocked: z.boolean(),
  updatedBy: z.string().nullable(),
});

export const notificationRow = row('Notification', {
  userId: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  data: z.unknown(),
  readAt: isoOrNull,
  createdAt: iso,
});

// --- catalog ----------------------------------------------------------------------------------------------------

export const catalogEntryRow = row('CatalogEntry', {
  slug: z.string(),
  kind: z.enum(CATALOG_KINDS),
  displayName: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  ownerTeamId: z.string().nullable(),
  visibility,
  status: z.enum(CATALOG_STATUSES),
  risk: z.enum(RISK_LEVELS),
  source: json,
  currentVersionId: z.string().nullable(),
  autoUpgrade: z.boolean(),
  userOverrides: z.enum(USER_OVERRIDE_LEVELS),
  onDrift: z.enum(DRIFT_POLICIES),
  createdBy: z.string(),
  createdAt: iso,
  registrySourceId: z.string().nullable().optional(),
  registryServerName: z.string().nullable().optional(),
});

export const versionTestRun = z
  .object({
    id: z.string(),
    versionId: z.string(),
    status: z.enum(['running', 'passed', 'failed']),
    steps: z.array(
      z.object({
        id: z.string(),
        status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
        detail: z.string().optional(),
        connectUrl: z.string().optional(),
      }),
    ),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: 'VersionTestRun' });

export const catalogVersionRow = row('CatalogVersion', {
  entryId: z.string(),
  label: z.string(),
  serverSpec: z.record(z.string(), z.unknown()).nullable(),
  overrides: json,
  guardProfileId: z.string().nullable(),
  limits: z.array(z.unknown()),
  installForm: installFormSchema.required(),
  lockfile: z.unknown(),
  referenceSnapshotId: z.string().nullable(),
  protocolEra: z.string().nullable(),
  testResult: versionTestRun.nullable(),
  runtime: json,
  status: z.enum(CATALOG_VERSION_STATUSES),
  changelog: z.string().nullable(),
  createdBy: z.string(),
  createdAt: iso,
  publishedAt: isoOrNull,
});

export const executableDiffEntry = z.looseObject({
  path: z.string(),
  change: z.enum(['added', 'modified', 'removed']),
  after: z.string().nullable().optional(),
});

export const versionApproval = z.object({
  status: z.enum(['not-required', 'pending', 'approved', 'stale']),
  reviewedDiffSha256: z.string(),
  executables: z.array(z.looseObject({})),
  diff: z.array(executableDiffEntry),
});

export const catalogVersionDetailRow = z
  .looseObject({ ...catalogVersionRow.shape, approval: versionApproval.optional() })
  .meta({ id: 'CatalogVersionDetail' });

export const catalogFileRow = z
  .looseObject({
    id: z.string(),
    path: z.string(),
    mode: z.enum(FILE_MODES),
    classification: z.enum(FILE_CLASSIFICATIONS),
    sha256: z.string(),
    size: z.number().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'CatalogFile' });

export const catalogFileContent = z
  .looseObject({ ...catalogFileRow.shape, contentBase64: z.string() })
  .meta({ id: 'CatalogFileContent' });

export const catalogFileList = pageSchema(catalogFileRow).extend({
  approval: versionApproval.nullable(),
});

export const pluginSourceRow = row('PluginSource', {
  name: z.string(),
  gitUrl: z.string(),
  ref: z.string(),
  path: z.string().nullable(),
  authSecretId: z.string().nullable(),
  tracked: z.boolean(),
  lastCommit: z.string().nullable(),
  lastSync: z.unknown(),
  createdAt: iso,
});

export const storeEntry = z
  .looseObject({
    id: z.string(),
    slug: z.string(),
    kind: z.enum(CATALOG_KINDS),
    displayName: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    risk: z.enum(RISK_LEVELS),
    ownerTeamId: z.string().nullable(),
    currentVersionId: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'StoreEntry' });

export const storeEntryDetail = z
  .looseObject({
    ...storeEntry.shape,
    version: z
      .object({
        id: z.string(),
        label: z.string(),
        changelog: z.string().nullable(),
        installForm: installFormSchema.required(),
        publishedAt: isoOrNull,
      })
      .nullable(),
  })
  .meta({ id: 'StoreEntryDetail' });

export const importResult = z
  .object({
    entry: catalogEntryRow,
    version: catalogVersionRow,
    warnings: z.array(z.string()),
  })
  .meta({ id: 'CatalogImportResult' });

/** One guard's verdict on one call or definition, as the pipeline records it (13.1, `GuardResultRecord`). */
export const guardResultRecord = z.looseObject({
  guard: z.string(),
  type: z.string(),
  phase: z.enum(['request', 'response', 'definition']),
  verdict: z.enum(['clean', 'suspicious', 'malicious', 'error']),
  score: z.number().optional(),
  action: z.string(),
  latencyMs: z.number(),
  modelVersion: z.string().optional(),
  mode: z.enum(['blocking', 'async']),
  error: z.string().optional(),
});

// --- installations, endpoints, drift, auto-install -------------------------------------------------------------

export const installationRow = row('Installation', {
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string(),
  catalogEntryId: z.string().nullable(),
  catalogVersionId: z.string().nullable(),
  pinnedVersion: z.boolean(),
  personalSpec: z.record(z.string(), z.unknown()).nullable(),
  slug: z.string(),
  toolPrefix: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  variables: z.record(z.string(), z.string()),
  secretRefs: json,
  overrides: json,
  origin: z.string(),
  status: z.enum(INSTALLATION_STATUSES),
  statusDetail: z.unknown(),
  createdAt: iso,
});

export const endpointRow = row('Endpoint', {
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  installationIds: z.array(z.string()),
  prefixMode: z.enum(['always', 'onCollision']),
  instructions: z.string().nullable(),
  createdAt: iso,
});

export const driftReviewRow = row('DriftReview', {
  catalogVersionId: z.string().nullable(),
  installationId: z.string().nullable(),
  itemKind: z.enum(ITEM_KINDS),
  itemKey: z.string(),
  oldHash: z.string().nullable(),
  newHash: z.string(),
  newDefinition: json,
  guardResults: z.array(guardResultRecord),
  status: z.enum(REVIEW_STATUSES),
  decidedBy: z.string().nullable(),
  decidedAt: isoOrNull,
  reason: z.string().nullable(),
  createdAt: iso,
});

export const autoInstallPolicyRow = row('AutoInstallPolicy', {
  catalogEntryId: z.string(),
  target: autoInstallTargetSchema,
  mode: z.enum(AUTO_INSTALL_MODES),
  scope: z.enum(AUTO_INSTALL_SCOPES),
  applyToExisting: z.boolean(),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: iso,
});

export const egressEntry = z
  .object({
    ts: z.string(),
    host: z.string(),
    port: z.number(),
    decision: z.enum(['allowed', 'denied']),
    bytesOut: z.number().optional(),
  })
  .meta({ id: 'EgressEntry' });

// --- registry ---------------------------------------------------------------------------------------------------

export const registrySourceRow = row('RegistrySource', {
  name: z.string(),
  baseUrl: z.string(),
  authSecretId: z.string().nullable(),
  authHeaderName: z.string().nullable(),
  trust: z.string(),
  enabled: z.boolean(),
  syncIntervalS: z.number().int(),
  lastUpdatedSince: isoOrNull,
  lastSync: z.unknown(),
  createdAt: iso,
});

export const installRequestRow = row('InstallRequest', {
  requesterId: z.string(),
  sourceId: z.string(),
  serverName: z.string(),
  version: z.string(),
  justification: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  decidedBy: z.string().nullable(),
  decidedAt: isoOrNull,
  reason: z.string().nullable(),
  createdAt: iso,
});

// --- policy, guards, limits, marketplaces ----------------------------------------------------------------------

export const policyRuleRow = row('PolicyRule', {
  name: z.string(),
  ownerTeamId: z.string().nullable(),
  effect: z.enum(POLICY_EFFECTS),
  who: toolRuleRowSchema.shape.who,
  what: toolRuleRowSchema.shape.what,
  when: toolRuleRowSchema.shape.when,
  enabled: z.boolean(),
  priority: z.number().int(),
  createdBy: z.string(),
  createdAt: iso,
});

export const customPolicyRow = row('CustomPolicy', {
  name: z.string(),
  cedar: z.string(),
  tests: z.array(z.unknown()),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: iso,
});

export const guardProfileRow = z
  .looseObject({
    id: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    isOrgDefault: z.boolean(),
    createdAt: iso,
    ...guardProfileSchema.omit({ profileId: true }).partial().shape,
  })
  .meta({ id: 'GuardProfile' });

const limitBase = RuleSchema.options[0].omit({ id: true, kind: true, params: true });
export const limitRuleRow = z
  .looseObject({
    id: z.string(),
    updatedAt: z.string(),
    ...limitBase.shape,
    kind: z.enum(LIMIT_KINDS),
    cost: z.record(z.string(), z.number()).nullable().optional(),
    params: z.record(z.string(), z.unknown()),
    ownerTeamId: z.string().nullable(),
    createdAt: iso,
  })
  .meta({ id: 'LimitRule' });

export const marketplaceRow = row('Marketplace', {
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  ownerTeamId: z.string().nullable(),
  audience: visibility,
  desktopInstallation: z.enum(DESKTOP_INSTALLATION_MODES),
  mirror: mirrorTargetSchema.nullable(),
  mirrorStatus: mirrorStateSchema.nullable(),
  promotedRelease: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: iso,
});

export const marketplaceItemRow = row('MarketplaceItem', {
  marketplaceId: z.string(),
  catalogEntryId: z.string(),
  policy: z.enum(MARKETPLACE_ITEM_POLICIES),
  pinnedVersionId: z.string().nullable(),
  position: z.number().int(),
});

export const executableApprovalRow = row('ExecutableApproval', {
  catalogVersionId: z.string(),
  approvedBy: z.string(),
  reviewedDiffSha256: z.string(),
  note: z.string().nullable(),
  approvedAt: iso,
  status: z.literal('approved'),
  paths: z.array(z.string()),
});

// --- observability ----------------------------------------------------------------------------------------------

export const callRecord = z
  .looseObject({
    id: z.string(),
    ts: z.string(),
    userId: z.string().nullable(),
    durationMs: z.number(),
    principalType: z.string(),
    principalId: z.string(),
    clientId: z.string().nullable(),
    clientName: z.string().nullable(),
    endpointId: z.string().nullable(),
    installationId: z.string().nullable(),
    catalogEntryId: z.string().nullable(),
    catalogVersionId: z.string().nullable(),
    method: z.string(),
    itemName: z.string().nullable(),
    upstreamName: z.string().nullable(),
    outcome: z.enum(CALL_OUTCOMES),
    errorCode: z.string().nullable(),
    jsonrpcCode: z.number().nullable(),
    eraDown: z.string(),
    eraUp: z.string().nullable(),
    coldStart: z.boolean(),
    bytesIn: z.number(),
    bytesOut: z.number(),
    guardResults: z.array(guardResultRecord).nullable(),
    policyReasons: z.array(z.string()).nullable(),
    argsPreview: z.unknown(),
    resultPreview: z.unknown(),
    traceId: z.string().nullable(),
    spanId: z.string().nullable(),
    origin: z.string(),
  })
  .meta({ id: 'CallRecord' });

export const findingRecord = z
  .looseObject({
    id: z.string(),
    ts: z.string(),
    kind: z.enum(['guard_block', 'drift', 'egress_denied']),
    subject: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'Finding' });

/** For responses whose handler type is not worth mirroring: the runtime schema still documents the shape. */
export const untyped = (schema: z.ZodType): z.ZodType<unknown, unknown> =>
  schema as unknown as z.ZodType<unknown, unknown>;

// --- pages ------------------------------------------------------------------------------------------------------

/** A row schema as route handlers see it: the generic store `Row` (the precise shape is the runtime schema). */
export const asRow = (schema: z.ZodType): z.ZodType<Row, Row> =>
  schema as unknown as z.ZodType<Row, Row>;

/** A named page of rows: `{ items, nextCursor }` registered as `<id>`. */
export const pageOf = (id: string, item: z.ZodType): z.ZodType<Page<Row>, Page<Row>> =>
  pageSchema(item).meta({ id }) as unknown as z.ZodType<Page<Row>, Page<Row>>;

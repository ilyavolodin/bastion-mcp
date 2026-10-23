/**
 * Declarative mapping of API collections onto Prisma models (16.2, docs/port-matrix.md). Collections that are not a
 * plain table (settings, service account clients, OAuth grants, installation secrets) live in `custom.ts`.
 */
import { type Collection, ConflictApiError, ValidationApiError } from '@bastion-mcp/api';
import { NIL_UUID, reindexCatalogSearch, type Tx } from '@bastion-mcp/db';
import type { CollectionSpec, Db, DbRow, StoreContext } from './collection';
import { isUuid } from './meta';

const str = (v: unknown): string => String(v);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const org = (): ['org', string] => ['org', NIL_UUID];

/**
 * `authSecretId` arrives as the name of an org secret (17.2); the column holds the secret id. A UUID is taken as is,
 * a name is resolved, an unknown name is a validation error.
 */
const resolveSecretRef = async (
  data: Record<string, unknown>,
  _existing: DbRow | null,
  ctx: StoreContext,
): Promise<Record<string, unknown>> => {
  const ref = data.authSecretId;
  if (typeof ref !== 'string' || isUuid(ref)) return data;
  const secret = await (
    ctx.db as unknown as {
      secret: { findFirst(args: object): Promise<{ id: string } | null> };
    }
  ).secret.findFirst({ where: { scope: 'org', ownerId: null, name: ref } });
  if (!secret) {
    throw new ValidationApiError('the referenced secret does not exist', [
      { path: '/authSecretId', message: `no org secret named "${ref}"` },
    ]);
  }
  return { ...data, authSecretId: secret.id };
};

const GUARD_SETTING_KEYS = ['maxScanBytes', 'onOversize', 'onDrift', 'riskEscalation'] as const;

/**
 * Rows keyed by an installation or a catalog version without a cascading foreign key (`upstream_snapshots` set the
 * key to null, `drift_reviews` have no key at all): they would be orphaned by a delete, so the delete removes them.
 */
const dropDerivedData = async (
  db: Db,
  by: { installationId: string } | { catalogVersionId: string | string[] },
): Promise<void> => {
  const where =
    'installationId' in by
      ? { installationId: by.installationId }
      : {
          catalogVersionId: Array.isArray(by.catalogVersionId)
            ? { in: by.catalogVersionId }
            : by.catalogVersionId,
        };
  const prisma = db as Tx;
  await prisma.upstreamSnapshot.deleteMany({ where });
  await prisma.driftReview.deleteMany({ where });
  await prisma.definitionPin.deleteMany({ where });
};

export const SPECS: Record<string, CollectionSpec> = {};
const add = (spec: CollectionSpec): void => {
  SPECS[spec.collection] = spec;
};

add({
  collection: 'users',
  model: 'User',
  hide: ['localPasswordHash'],
  search: ['email', 'displayName'],
  bump: (r) => ['user', str(r.id)],
});
add({
  collection: 'teams',
  model: 'Team',
  search: ['slug', 'displayName'],
  bump: (r) => ['team', str(r.id)],
});
add({
  collection: 'team_members',
  model: 'TeamMembership',
  key: ['teamId', 'userId'],
  order: [{ teamId: 'asc' }, { createdAt: 'asc' }, { userId: 'asc' }],
  bump: (r) => ['team', str(r.teamId)],
});
add({ collection: 'role_mapping_rules', model: 'RoleMappingRule', bump: org });
add({
  collection: 'service_accounts',
  model: 'ServiceAccount',
  hide: ['secretSha256', 'jwks'],
  search: ['slug', 'displayName'],
});
add({ collection: 'idp_connections', model: 'IdpConnection', search: ['name'] });
add({ collection: 'scim_tokens', model: 'ScimToken', search: ['name'] });
add({
  collection: 'oauth_clients',
  model: 'OauthClientPolicy',
  key: ['clientId'],
  search: ['clientId'],
});
add({
  collection: 'notifications',
  model: 'Notification',
  hide: ['kind', 'payload'],
  decorate: (db, row) => {
    const payload = obj(db.payload);
    // Drift notices stored before the title/data envelope (kind `drift_review`, the bare ids in the payload).
    const legacyDrift = db.kind === 'drift_review' && payload.title === undefined;
    row.type = legacyDrift ? 'drift' : db.kind;
    row.title = legacyDrift ? `Definition changed: ${str(payload.tool)}` : (payload.title ?? null);
    row.data = legacyDrift
      ? { message: 'Review it on the Security page.', ...payload }
      : (payload.data ?? null);
  },
  mapIn: (data, existing) => {
    const { type, title, data: body, ...rest } = data;
    const payload = { ...obj(existing?.payload) };
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.data = body;
    const touched = title !== undefined || body !== undefined;
    return {
      ...rest,
      ...(type === undefined ? {} : { kind: type }),
      ...(touched || !existing ? { payload } : {}),
    };
  },
});
add({
  collection: 'catalog_entries',
  model: 'CatalogEntry',
  hide: ['iconBlob'],
  search: ['slug', 'displayName', 'description'],
  bump: (r) => ['catalog', str(r.id)],
  decorate: (db, row) => {
    const source = obj(db.source);
    if (source.type === 'registry') {
      row.registrySourceId = source.registrySourceId ?? null;
      row.registryServerName = source.serverName ?? null;
    }
  },
  mapIn: (data) => {
    const { registrySourceId: _a, registryServerName: _b, ...rest } = data;
    return rest;
  },
  virtualWhere: {
    registrySourceId: (v) => ({ source: { path: ['registrySourceId'], equals: v } }),
    registryServerName: (v) => ({ source: { path: ['serverName'], equals: v } }),
  },
  afterWrite: async (ctx, row) => {
    await reindexCatalogSearch(ctx.db as Tx, str(row.id));
  },
  // Versions are removed one by one by the service (their snapshots and drift reviews go with them, see
  // `dropDerivedData`); files, approvals, pins and auto-install policies cascade in the database. A marketplace item
  // restricts the delete, so it is refused with guidance rather than surfacing a foreign-key error.
  beforeRemove: async (ctx, row) => {
    const prisma = ctx.db as Tx;
    const items = await prisma.marketplaceItem.count({ where: { catalogEntryId: str(row.id) } });
    if (items > 0) {
      throw new ConflictApiError(
        `this entry is part of ${items} marketplace${items === 1 ? '' : 's'}. Remove it from the marketplace first, or deprecate it to hide it from the Store.`,
        { code: 'entry_in_use' },
      );
    }
  },
});
add({
  collection: 'catalog_versions',
  model: 'CatalogVersion',
  order: [{ createdAt: 'asc' }, { id: 'asc' }],
  search: ['label'],
  bump: (r) => ['catalog', str(r.entryId)],
  beforeRemove: (ctx, row) => dropDerivedData(ctx.db, { catalogVersionId: str(row.id) }),
});
add({
  collection: 'catalog_files',
  model: 'CatalogFile',
  key: ['catalogVersionId', 'path'],
  hide: ['blobSha256Rel'],
  include: { include: { blobSha256Rel: { select: { size: true } } } },
  decorate: (db, row) => {
    row.size = obj(db.blobSha256Rel).size ?? null;
  },
});
add({ collection: 'executable_approvals', model: 'ExecutableApproval', key: ['catalogVersionId'] });
add({
  collection: 'plugin_sources',
  model: 'PluginSource',
  search: ['name', 'gitUrl'],
  mapIn: resolveSecretRef,
});
add({
  collection: 'installations',
  model: 'Installation',
  search: ['slug', 'displayName'],
  bump: (r) => ['installation', str(r.id)],
  beforeRemove: (ctx, row) => dropDerivedData(ctx.db, { installationId: str(row.id) }),
});
add({
  collection: 'endpoints',
  model: 'Endpoint',
  search: ['slug', 'displayName'],
  bump: (r) => ['endpoint', str(r.id)],
});
add({
  collection: 'drift_reviews',
  model: 'DriftReview',
  order: [{ createdAt: 'desc' }, { id: 'asc' }],
  bump: org,
});
add({ collection: 'definition_pins', model: 'DefinitionPin', deriveId: true, bump: org });
add({ collection: 'auto_install_policies', model: 'AutoInstallPolicy' });
add({
  collection: 'auto_install_applications',
  model: 'AutoInstallApplication',
  key: ['policyId', 'subjectType', 'subjectId'],
});
add({
  collection: 'registry_sources',
  model: 'RegistrySource',
  search: ['name', 'baseUrl'],
  mapIn: resolveSecretRef,
});
add({ collection: 'registry_policies', model: 'RegistryPolicy', key: ['sourceId'] });
add({
  collection: 'install_requests',
  model: 'InstallRequest',
  search: ['serverName'],
});
add({
  collection: 'policy_rules',
  model: 'PolicyRule',
  search: ['name'],
  bump: org,
  defaults: { createdBy: NIL_UUID },
});
add({
  collection: 'custom_policies',
  model: 'CustomPolicy',
  search: ['name'],
  bump: org,
  defaults: { createdBy: NIL_UUID },
});
add({
  collection: 'guard_profiles',
  model: 'GuardProfile',
  search: ['name'],
  bump: org,
  hide: ['settings'],
  decorate: (db, row) => {
    for (const [k, v] of Object.entries(obj(db.settings))) row[k] = v;
  },
  mapIn: (data, existing) => {
    const settings: Record<string, unknown> = { ...obj(existing?.settings) };
    const rest: Record<string, unknown> = {};
    let touched = false;
    for (const [k, v] of Object.entries(data)) {
      if ((GUARD_SETTING_KEYS as readonly string[]).includes(k)) {
        settings[k] = v;
        touched = true;
      } else rest[k] = v;
    }
    return touched || !existing ? { ...rest, settings } : rest;
  },
});
add({
  collection: 'limit_rules',
  model: 'LimitRule',
  search: ['name'],
  bump: org,
});
add({ collection: 'marketplaces', model: 'Marketplace', search: ['slug', 'displayName'] });
add({
  collection: 'marketplace_items',
  model: 'MarketplaceItem',
  key: ['marketplaceId', 'catalogEntryId'],
  order: [{ marketplaceId: 'asc' }, { position: 'asc' }, { catalogEntryId: 'asc' }],
});

export const GENERIC_COLLECTIONS = new Set<Collection>(Object.keys(SPECS) as Collection[]);
export type { DbRow };

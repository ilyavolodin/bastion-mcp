import { slugify, UI_CLIENT_ID } from '@bastion-mcp/core';
import { type OverridesDocument, parseOverrides } from '@bastion-mcp/overrides';
import type { PrincipalData } from '@bastion-mcp/policy';
import {
  assertInstallationSlugAvailable,
  compileEndpoint,
  type EffectiveEndpoint,
  type InstallationInfo,
  type InstallationStatus,
  type UpstreamItemSource,
} from '@bastion-mcp/router';
import type { z as zType } from 'zod';
import { z } from 'zod';
import {
  ConflictApiError,
  ForbiddenApiError,
  NotFoundApiError,
  ValidationApiError,
} from '../errors';
import { toPolicyPrincipal } from '../framework/auth';
import type { ApiDeps } from '../ports';
import type { SecretMeta } from '../ports/secrets';
import type { Page, Row } from '../ports/store';
import type { installationCreateSchema, installationPatchSchema } from '../schemas/installations';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';
import { installationResource } from './resources';

export const installations = new CrudService({
  collection: 'installations',
  targetType: 'installation',
  action: 'installation',
  configTopic: 'installations',
});

type CreateBody = zType.output<typeof installationCreateSchema>;
type PatchBody = zType.output<typeof installationPatchSchema>;

/** Reads an org setting row (`settings` collection, id = key, `value` = JSON) (19.2). */
export const readSetting = async <T>(deps: ApiDeps, key: string, fallback: T): Promise<unknown> => {
  const row = await deps.store.get('settings', key);
  return row && 'value' in row ? row.value : fallback;
};

const personalInstallsSetting = z.enum(['off', 'remoteOnly', 'all']).catch('remoteOnly');

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const requireInstallation = async (
  deps: ApiDeps,
  id: string,
  store: Pick<ApiDeps['store'], 'get'> = deps.store,
): Promise<Row> => {
  const row = await store.get('installations', id);
  if (!row) throw new NotFoundApiError('installation');
  return row;
};

// --- listing ------------------------------------------------------------------------------------------

/** Lists the installations the caller may manage (own, their teams', all for admins); Cedar decides per row. */
export const listInstallations = async (
  ctx: ReadCtx,
  query: {
    limit: number;
    cursor?: string | undefined;
    q?: string | undefined;
    sort?: string | undefined;
    status?: string | undefined;
    catalogEntryId?: string | undefined;
  },
): Promise<Page<Row>> => {
  const sort = query.sort
    ? query.sort.startsWith('-')
      ? { field: query.sort.slice(1), desc: true }
      : { field: query.sort, desc: false }
    : undefined;
  const page = await ctx.deps.store.list('installations', {
    limit: query.limit,
    cursor: query.cursor,
    q: query.q,
    sort,
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.catalogEntryId ? { catalogEntryId: query.catalogEntryId } : {}),
    },
  });
  const items: Row[] = [];
  for (const row of page.items) {
    const entry = str(row.catalogEntryId)
      ? await ctx.deps.store.get('catalog_entries', String(row.catalogEntryId))
      : null;
    if (
      ctx.can(
        'installation.manage',
        installationResource(await withServiceTeam(ctx.deps, row), entry),
      )
    ) {
      items.push(row);
    }
  }
  return { items, nextCursor: page.nextCursor };
};

const withServiceTeam = async (deps: ApiDeps, row: Row): Promise<Row> => {
  if (row.ownerType !== 'service' || !str(row.ownerId)) return row;
  const account = await deps.store.get('service_accounts', String(row.ownerId));
  return account && str(account.teamId) ? { ...row, ownerServiceTeamId: account.teamId } : row;
};

// --- creation -----------------------------------------------------------------------------------------

type OwnerInfo = { type: 'user' | 'team'; id: string };

const visibleSlugs = async (deps: ApiDeps, principalId: string, teamIds: readonly string[]) => {
  const own = await deps.store.find('installations', { ownerType: 'user', ownerId: principalId });
  const out: Array<{
    slug: string;
    owner: { kind: 'user'; id: string } | { kind: 'team'; id: string; slug: string };
  }> = own.map((r) => ({
    slug: String(r.slug),
    owner: { kind: 'user' as const, id: principalId },
  }));
  for (const teamId of teamIds) {
    const team = await deps.store.get('teams', teamId);
    const rows = await deps.store.find('installations', { ownerType: 'team', ownerId: teamId });
    for (const r of rows) {
      out.push({
        slug: String(r.slug),
        owner: { kind: 'team' as const, id: teamId, slug: String(team?.slug ?? teamId) },
      });
    }
  }
  return out;
};

export const createInstallation = async (ctx: WriteCtx, body: CreateBody): Promise<Row> => {
  const { deps, tx } = ctx;
  const owner: OwnerInfo =
    body.ownerType === 'team'
      ? { type: 'team', id: body.teamId ?? '' }
      : { type: 'user', id: ctx.principal.id };

  let entry: Row | null = null;
  let version: Row | null = null;
  if (body.catalogEntryId !== undefined) {
    entry = await tx.store.get('catalog_entries', body.catalogEntryId);
    if (!entry) throw new NotFoundApiError('catalog entry');
    const versionId = body.catalogVersionId ?? str(entry.currentVersionId);
    if (!versionId) {
      throw new ConflictApiError('the catalog entry has no published version', {
        code: 'no_published_version',
      });
    }
    version = await tx.store.get('catalog_versions', versionId);
    if (!version || version.entryId !== entry.id) throw new NotFoundApiError('catalog version');
    if (version.status !== 'published') {
      throw new ConflictApiError('only published versions can be installed', {
        code: 'version_not_published',
      });
    }
  } else {
    const mode = personalInstallsSetting.parse(
      await readSetting(deps, 'personalInstalls', 'remoteOnly'),
    );
    if (mode === 'off') {
      throw new ForbiddenApiError('personal installations are disabled by the organization', {
        setting: 'personalInstalls',
      });
    }
    if (mode === 'remoteOnly' && body.personalSpec?.type !== 'remote') {
      throw new ForbiddenApiError('only remote servers may be installed personally', {
        setting: 'personalInstalls',
      });
    }
  }

  const baseSlug = body.slug ?? slugify(str(entry?.slug) ?? str(body.displayName) ?? 'server');
  if (baseSlug.length < 2)
    throw new ValidationApiError('the slug is too short', [
      { path: '/slug', message: 'at least 2 characters' },
    ]);
  if (owner.type === 'team') {
    const clash = await tx.store.find('installations', {
      ownerType: 'team',
      ownerId: owner.id,
      slug: baseSlug,
    });
    if (clash.length > 0)
      throw new ConflictApiError('a team installation with this slug exists', {
        code: 'slug_collision',
      });
  } else {
    assertInstallationSlugAvailable(
      baseSlug,
      await visibleSlugs(
        deps,
        ctx.principal.id,
        ctx.principal.teams.map((t) => t.teamId),
      ),
    );
  }

  const row = await tx.store.insert('installations', {
    id: deps.newId(),
    ownerType: owner.type,
    ownerId: owner.id,
    catalogEntryId: entry?.id ?? null,
    catalogVersionId: version?.id ?? null,
    pinnedVersion: body.pinnedVersion,
    personalSpec: body.personalSpec ?? null,
    slug: baseSlug,
    toolPrefix: body.toolPrefix ?? baseSlug.replace(/-/g, '_'),
    displayName: body.displayName ?? str(entry?.displayName) ?? baseSlug,
    enabled: true,
    variables: body.variables,
    secretRefs: {},
    overrides: {},
    origin: entry ? 'catalog' : 'personal',
    status: 'ready',
    statusDetail: null,
    createdAt: deps.clock.now().toISOString(),
  });
  await tx.audit({
    action: 'installation.create',
    targetType: 'installation',
    targetId: row.id,
    diff: {
      ownerType: owner.type,
      ownerId: owner.id,
      catalogEntryId: entry?.id ?? null,
      origin: row.origin,
    },
  });
  tx.configChanged('installations');
  tx.emit({
    id: deps.newId(),
    type: 'installation.status',
    audience: owner.type === 'team' ? { teamIds: [owner.id] } : { userIds: [owner.id] },
    data: { installationId: row.id, status: row.status },
    topic: row.id,
  });
  return row;
};

export const updateInstallation = async (
  ctx: WriteCtx,
  id: string,
  patch: PatchBody,
): Promise<Row> => {
  const current = await requireInstallation(ctx.deps, id, ctx.tx.store);
  const changes: Record<string, unknown> = { ...patch };
  if (patch.catalogVersionId !== undefined) {
    const version = await ctx.tx.store.get('catalog_versions', patch.catalogVersionId);
    if (!version || version.entryId !== current.catalogEntryId) {
      throw new NotFoundApiError('catalog version');
    }
    if (version.status !== 'published') {
      throw new ConflictApiError('only published versions can be installed', {
        code: 'version_not_published',
      });
    }
  }
  return installations.update(ctx, id, changes);
};

// --- runtime operations -------------------------------------------------------------------------------

export const restartInstallation = async (ctx: WriteCtx, id: string): Promise<{ ok: true }> => {
  await requireInstallation(ctx.deps, id, ctx.tx.store);
  await ctx.deps.installations.runtime.restart(id);
  await ctx.tx.audit({ action: 'installation.restart', targetType: 'installation', targetId: id });
  return { ok: true };
};

export const beginConnect = async (
  ctx: WriteCtx,
  id: string,
  returnTo: string | undefined,
): Promise<{ authorizationUrl: string }> => {
  await requireInstallation(ctx.deps, id, ctx.tx.store);
  const out = await ctx.deps.installations.connect.begin({
    installationId: id,
    principalId: ctx.principal.id,
    ...(returnTo === undefined ? {} : { returnTo }),
  });
  await ctx.tx.audit({
    action: 'installation.connect_begin',
    targetType: 'installation',
    targetId: id,
  });
  return { authorizationUrl: out.authorizationUrl };
};

export const disconnect = async (ctx: WriteCtx, id: string): Promise<void> => {
  const row = await requireInstallation(ctx.deps, id, ctx.tx.store);
  await ctx.deps.installations.connect.disconnect({
    installationId: id,
    principalId: ctx.principal.id,
  });
  const status: InstallationStatus = row.enabled === false ? 'disabled' : 'reconnect_required';
  await ctx.tx.store.update('installations', id, { status });
  await ctx.tx.audit({
    action: 'installation.disconnect',
    targetType: 'installation',
    targetId: id,
  });
  ctx.tx.configChanged('installations');
};

/** Secrets of an installation live with its owner: user secrets for personal, team secrets for team ones (11.4). */
export const putInstallationSecret = async (
  ctx: WriteCtx,
  id: string,
  name: string,
  value: string,
): Promise<SecretMeta & { updatedAt: string }> => {
  const row = await requireInstallation(ctx.deps, id, ctx.tx.store);
  const ownerId = str(row.ownerId) ?? '';
  let scope: 'user' | 'team' = row.ownerType === 'user' ? 'user' : 'team';
  let scopeOwner = ownerId;
  if (row.ownerType === 'service') {
    const account = await ctx.tx.store.get('service_accounts', ownerId);
    scope = 'team';
    scopeOwner = str(account?.teamId) ?? ownerId;
  }
  const meta = await ctx.deps.secrets.put({
    scope,
    ownerId: scopeOwner,
    name: `${id}.${name}`,
    value,
  });
  const refs = z.record(z.string(), z.unknown()).catch({}).parse(row.secretRefs);
  await ctx.tx.store.update('installations', id, {
    secretRefs: { ...refs, [name]: { scope, name: meta.name, version: meta.version } },
  });
  await ctx.tx.audit({
    action: 'installation.secret_set',
    targetType: 'installation',
    targetId: id,
    diff: { name, scope, version: meta.version },
  });
  ctx.tx.configChanged('installations');
  return meta;
};

// --- final definitions --------------------------------------------------------------------------------

const parseLayer = (value: unknown): OverridesDocument | undefined => {
  if (value === null || value === undefined) return undefined;
  const parsed = parseOverrides(value);
  return parsed.ok ? parsed.doc : undefined;
};

export const loadLayers = async (
  deps: ApiDeps,
  row: Row,
): Promise<{
  catalog: OverridesDocument | undefined;
  installation: OverridesDocument | undefined;
}> => {
  const versionId = str(row.catalogVersionId);
  const version = versionId ? await deps.store.get('catalog_versions', versionId) : null;
  return { catalog: parseLayer(version?.overrides), installation: parseLayer(row.overrides) };
};

const infoStatus = z
  .enum(['ready', 'needs_setup', 'reconnect_required', 'error', 'disabled'])
  .catch('ready');

export const installationInfo = async (deps: ApiDeps, row: Row): Promise<InstallationInfo> => {
  const entry = str(row.catalogEntryId)
    ? await deps.store.get('catalog_entries', String(row.catalogEntryId))
    : null;
  const ownerId = str(row.ownerId) ?? '';
  const team = row.ownerType === 'team' ? await deps.store.get('teams', ownerId) : null;
  const owner: InstallationInfo['owner'] =
    row.ownerType === 'team'
      ? { kind: 'team', id: ownerId, slug: str(team?.slug) ?? ownerId }
      : row.ownerType === 'service'
        ? { kind: 'service', id: ownerId }
        : { kind: 'user', id: ownerId };
  const status = infoStatus.parse(row.status);
  const slug = String(row.slug);
  return {
    id: row.id,
    slug,
    toolPrefix: str(row.toolPrefix) ?? slug.replace(/-/g, '_'),
    displayName: str(row.displayName) ?? slug,
    owner,
    enabled: row.enabled !== false,
    status,
    catalogEntryId: str(row.catalogEntryId) ?? row.id,
    ...(str(row.catalogVersionId) ? { catalogVersionId: String(row.catalogVersionId) } : {}),
    ...(str(entry?.slug) ? { catalogSlug: String(entry?.slug) } : {}),
    layers: await loadLayers(deps, row),
    pinned: row.pinnedVersion === true,
    capabilities: { tools: true, prompts: true, resources: true },
    needsAuth: status === 'reconnect_required',
  };
};

/** The principal whose view is compiled: the owner for user installations (an admin inspects what the owner sees). */
const viewerOf = async (ctx: ReadCtx, row: Row): Promise<PrincipalData> => {
  if (row.ownerType === 'user' && row.ownerId !== ctx.principal.id) {
    const record = await ctx.deps.principals.getPrincipal(String(row.ownerId));
    if (record) {
      return toPolicyPrincipal({
        id: record.id,
        type: record.type,
        orgRole: record.orgRole,
        teams: record.teams,
        active: record.active,
        authMethod: 'session',
        clientId: null,
        scopes: [],
        endpointRestriction: null,
        credentialId: null,
      });
    }
  }
  return ctx.subject;
};

export const compileInstallation = async (
  ctx: ReadCtx & { signal?: AbortSignal | undefined },
  row: Row,
): Promise<EffectiveEndpoint> => {
  const info = await installationInfo(ctx.deps, row);
  const subject = await viewerOf(ctx, row);
  const now = ctx.deps.clock.now();
  const source: UpstreamItemSource = {
    listItems: async (installation, c) => {
      const out = await ctx.deps.installations.definitions.listItems(
        installation.id,
        c.principalId,
        c.signal,
      );
      return out.status === 'ok' ? { status: 'ok', items: out.items, origin: 'live' } : out;
    },
  };
  return compileEndpoint({
    principal: subject,
    endpoint: {
      id: `installation:${row.id}`,
      kind: 'installation',
      installationIds: [row.id],
      prefixMode: 'onCollision',
    },
    installations: [info],
    source,
    policy: await ctx.deps.policy.engine(),
    requestContext: {
      clientId: UI_CLIENT_ID,
      clientName: 'Bastion UI',
      ip: '127.0.0.1',
      authMethod: ctx.principal.authMethod,
      hour: now.getUTCHours(),
      weekday: now.getUTCDay(),
      endpoint: '',
    },
    org: { displayName: 'Bastion' },
    serverVersion: '1',
    configVersion: row.updatedAt,
    signal: ctx.signal,
  });
};

export type DefinitionKind = 'tool' | 'prompt' | 'resource' | 'resourceTemplate';

/** `GET /installations/{id}/tools|prompts|resources|templates`: the final definitions after overrides (12.5). */
export const finalDefinitions = async (
  ctx: ReadCtx & { signal?: AbortSignal | undefined },
  id: string,
  kind: DefinitionKind,
) => {
  const row = await requireInstallation(ctx.deps, id);
  const endpoint = await compileInstallation(ctx, row);
  const items =
    kind === 'tool'
      ? endpoint.tools
      : kind === 'prompt'
        ? endpoint.prompts
        : kind === 'resource'
          ? endpoint.resources
          : endpoint.resourceTemplates;
  return {
    items,
    meta: endpoint.items.filter((m) => m.kind === kind),
    degraded: endpoint.degraded,
    needsAuth: endpoint.needsAuth,
    warnings: endpoint.warnings,
    ...(endpoint.instructions === undefined ? {} : { instructions: endpoint.instructions }),
  };
};

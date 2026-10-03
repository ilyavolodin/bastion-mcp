import type { Principal } from '@bastion-mcp/auth';
import { slugify } from '@bastion-mcp/core';
import {
  type ApprovalContext,
  approveRequest,
  approverIds,
  assertRegistryBaseUrl,
  availableRuntimes,
  buildInstallPlan,
  createInstallRequest,
  DEFAULT_REGISTRY_POLICY,
  describeInstall,
  evaluateInstall,
  type InstallActor,
  type InstallEvaluation,
  type InstallPlan,
  type InstallRequest,
  isNamespaceAllowed,
  type MappingResult,
  parseRegistryPolicy,
  type RegistryAuditEvent,
  type RegistryPolicy,
  type RegistryServerRow,
  type RegistrySource,
  type RegistryTrust,
  rejectRequest,
  riskFromTrust,
  runOsvGate,
  type SyncStats,
  serverJsonToSpec,
} from '@bastion-mcp/registry';
import { ApiError, ConflictApiError, ForbiddenApiError, NotFoundApiError } from '../errors';
import type { ApiDeps } from '../ports';
import type { Row } from '../ports/store';
import { CrudService, nowIso, type ReadCtx, type WriteCtx } from './crud';

export const registrySources = new CrudService({
  collection: 'registry_sources',
  targetType: 'registry_source',
  action: 'registry_source',
  configTopic: 'registry',
});

// --- row <-> domain -------------------------------------------------------------------------------------------

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const TRUST: readonly RegistryTrust[] = ['official', 'internal', 'community'];

export const sourceOf = (row: Row): RegistrySource => ({
  id: row.id,
  name: String(row.name),
  baseUrl: String(row.baseUrl),
  authSecretId: typeof row.authSecretId === 'string' ? row.authSecretId : null,
  authHeaderName: typeof row.authHeaderName === 'string' ? row.authHeaderName : null,
  trust: TRUST.find((t) => t === row.trust) ?? 'community',
  enabled: row.enabled !== false,
  syncIntervalS: typeof row.syncIntervalS === 'number' ? row.syncIntervalS : 3600,
  lastUpdatedSince: asDate(row.lastUpdatedSince),
  lastSync: (row.lastSync ?? null) as SyncStats | null,
});

const REQUEST_STATUS = ['open', 'approved', 'rejected', 'cancelled'] as const;

export const requestOf = (row: Row): InstallRequest => ({
  id: row.id,
  requesterId: String(row.requesterId),
  sourceId: String(row.sourceId),
  serverName: String(row.serverName),
  version: String(row.version),
  justification: typeof row.justification === 'string' ? row.justification : null,
  status: REQUEST_STATUS.find((s) => s === row.status) ?? 'open',
  decidedBy: typeof row.decidedBy === 'string' ? row.decidedBy : null,
  decidedAt: asDate(row.decidedAt),
  reason: typeof row.reason === 'string' ? row.reason : null,
  createdAt: asDate(row.createdAt) ?? new Date(0),
});

const requestFields = (r: InstallRequest): Record<string, unknown> => ({
  requesterId: r.requesterId,
  sourceId: r.sourceId,
  serverName: r.serverName,
  version: r.version,
  justification: r.justification,
  status: r.status,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
});

export const actorOf = (principal: Principal): InstallActor => ({
  id: principal.id,
  orgRole: principal.orgRole,
  managedTeamIds: principal.teams.filter((t) => t.role === 'manager').map((t) => t.teamId),
});

// --- sources ----------------------------------------------------------------------------------------------------

const checkBaseUrl = (deps: ApiDeps, url: string): Promise<string> =>
  assertRegistryBaseUrl(url, {
    ...(deps.registry.resolveHost ? { resolveHost: deps.registry.resolveHost } : {}),
  });

/**
 * Starts a sync once the surrounding transaction committed, without holding the request: a first walk of the official
 * registry fetches thousands of entries and must not run inside a transaction or an HTTP call. The port records
 * `last_sync` itself; the screen polls the source for the result.
 */
const syncAfterCommit = (ctx: WriteCtx, source: RegistrySource, full: boolean): void => {
  ctx.tx.afterCommit(() => {
    void ctx.deps.registry.sync(source, { full }).catch(() => undefined);
  });
};

export const createSource = async (
  ctx: WriteCtx,
  body: Record<string, unknown> & { baseUrl: string },
) => {
  const row = await registrySources.create(ctx, {
    ...body,
    baseUrl: await checkBaseUrl(ctx.deps, body.baseUrl),
    lastUpdatedSince: null,
    lastSync: null,
  });
  // A source that starts enabled is mirrored at once, so it is browsable without a manual sync.
  const created = sourceOf(row as unknown as Row);
  if (created.enabled) syncAfterCommit(ctx, created, true);
  return row;
};

export const updateSource = async (ctx: WriteCtx, id: string, patch: Record<string, unknown>) => {
  const before = sourceOf(await registrySources.require(ctx, id));
  const next =
    typeof patch.baseUrl === 'string'
      ? { ...patch, baseUrl: await checkBaseUrl(ctx.deps, patch.baseUrl) }
      : patch;
  const row = await registrySources.update(ctx, id, next);
  const after = sourceOf(row as unknown as Row);
  // Enabling a source (or pointing it at another registry) starts its initial sync.
  if (after.enabled && (!before.enabled || before.baseUrl !== after.baseUrl)) {
    syncAfterCommit(ctx, after, true);
  }
  return row;
};

export const deleteSource = async (ctx: WriteCtx, id: string): Promise<void> => {
  await registrySources.remove(ctx, id);
  await ctx.tx.store.remove('registry_policies', id);
};

/** Runs a sync now and records `last_sync` (11.6). */
export const syncNow = async (ctx: WriteCtx, id: string, full: boolean) => {
  const source = sourceOf(await registrySources.require(ctx, id));
  if (!source.enabled) {
    throw new ConflictApiError('this registry source is disabled', 'source_disabled');
  }
  syncAfterCommit(ctx, source, full);
  await ctx.tx.audit({
    action: 'registry_source.sync',
    targetType: 'registry_source',
    targetId: id,
    diff: { queued: true, full },
  });
  ctx.tx.configChanged('registry');
  const at = new Date().toISOString();
  return {
    ok: true,
    queued: true,
    stats: {
      startedAt: at,
      finishedAt: at,
      ok: true,
      full,
      pages: 0,
      fetched: 0,
      upserted: 0,
      invalid: 0,
      deleted: 0,
      deprecated: 0,
    } satisfies SyncStats,
    deletedNames: [] as string[],
    deprecatedNames: [] as string[],
  };
};

export const getPolicy = async (ctx: Pick<ReadCtx, 'deps'>, sourceId: string) => {
  await registrySources.require(ctx, sourceId);
  const row = await ctx.deps.store.get('registry_policies', sourceId);
  return {
    sourceId,
    policy: row ? parseRegistryPolicy(row.policy) : DEFAULT_REGISTRY_POLICY,
    updatedAt: row?.updatedAt ?? null,
  };
};

export const policyVersion = async (
  ctx: Pick<ReadCtx, 'deps'>,
  sourceId: string,
): Promise<string | null> =>
  (await ctx.deps.store.get('registry_policies', sourceId))?.updatedAt ?? null;

export const putPolicy = async (ctx: WriteCtx, sourceId: string, policy: RegistryPolicy) => {
  await registrySources.require(ctx, sourceId);
  const row = await ctx.tx.store.upsert('registry_policies', sourceId, { policy });
  await ctx.tx.audit({
    action: 'registry_policy.update',
    targetType: 'registry_source',
    targetId: sourceId,
    diff: { policy },
  });
  ctx.tx.configChanged('registry');
  return { sourceId, policy, updatedAt: row.updatedAt };
};

// --- servers ------------------------------------------------------------------------------------------------------

const safeMap = (row: RegistryServerRow, prefer?: 'remote' | 'package'): MappingResult => {
  try {
    return serverJsonToSpec(row.serverJson, prefer ? { prefer } : {});
  } catch (error) {
    return {
      installable: false,
      reason: 'no runtime',
      detail: error instanceof Error ? error.message : 'the entry cannot be mapped',
      registryTypes: [],
    };
  }
};

export const serverSummary = (
  row: RegistryServerRow,
  source?: { name: string; trust: RegistryTrust; enabled: boolean },
) => ({
  sourceId: row.sourceId,
  ...(source
    ? { sourceName: source.name, trust: source.trust, sourceEnabled: source.enabled }
    : {}),
  name: row.name,
  version: row.version,
  status: row.status,
  isLatest: row.isLatest,
  title: row.serverJson.title ?? row.name,
  description: row.serverJson.description,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  runtimes: availableRuntimes(row.serverJson),
});

/**
 * Admins and Auditors see every mirrored server, so they can curate the list. Everybody else sees the servers the
 * source policy lets through: its namespace allow and block lists decide what is SHOWN as well as what may be
 * installed (allow `*` and block a few names, or allow only the names you want shown).
 */
const seesWholeRegistry = (principal: Pick<Principal, 'orgRole'>): boolean =>
  principal.orgRole === 'admin' || principal.orgRole === 'auditor';

const policiesBySource = async (deps: ApiDeps): Promise<Map<string, RegistryPolicy>> => {
  const rows = await deps.store.list('registry_policies', { limit: 200 });
  return new Map(rows.items.map((row) => [row.id, parseRegistryPolicy(row.policy)]));
};

const PAGES_TO_FILL = 8;

export const searchServers = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  query: {
    q?: string | undefined;
    sourceId?: string | undefined;
    includeDeleted?: boolean | undefined;
    includeDisabled?: boolean | undefined;
    latestOnly?: boolean | undefined;
    runtime?: 'remote' | 'npm' | 'pypi' | undefined;
    limit: number;
    cursor?: string | undefined;
  },
) => {
  const sourceRows = await ctx.deps.store.list('registry_sources', { limit: 200 });
  const sources = new Map(sourceRows.items.map((row) => [row.id, sourceOf(row)]));
  const policies = await policiesBySource(ctx.deps);
  const shown = (row: RegistryServerRow): boolean =>
    isNamespaceAllowed(policies.get(row.sourceId) ?? DEFAULT_REGISTRY_POLICY, row.name);
  const everything = seesWholeRegistry(ctx.principal);

  const items: (ReturnType<typeof serverSummary> & { visibleToMembers: boolean })[] = [];
  let cursor = query.cursor;
  let next: string | null = null;
  // A person who sees only part of the list gets full pages: keep reading until the page is filled.
  for (let n = 0; n < PAGES_TO_FILL; n += 1) {
    const page = await ctx.deps.registry.servers.search({
      ...(query.q ? { q: query.q } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.runtime ? { runtime: query.runtime } : {}),
      includeDeleted: query.includeDeleted === true,
      // Rows of a disabled source cannot be installed: they are listed only when asked for.
      enabledSourcesOnly: query.includeDisabled !== true,
      latestOnly: query.latestOnly !== false,
      limit: query.limit,
      cursor,
    });
    for (const row of page.items) {
      if (!everything && !shown(row)) continue;
      items.push({
        ...serverSummary(row, sources.get(row.sourceId)),
        visibleToMembers: shown(row),
      });
    }
    next = page.nextCursor ?? null;
    if (next === null || items.length >= query.limit) break;
    cursor = next;
  }
  return { items, nextCursor: next };
};

const findServer = async (
  deps: ApiDeps,
  sourceId: string,
  name: string,
  version: string,
): Promise<RegistryServerRow> => {
  const rows = await deps.registry.servers.list(sourceId, { name });
  const row = rows.find((r) => r.version === version);
  if (!row) throw new NotFoundApiError('registry server');
  return row;
};

const loadPolicy = async (deps: ApiDeps, sourceId: string): Promise<RegistryPolicy> => {
  const row = await deps.store.get('registry_policies', sourceId);
  return row ? parseRegistryPolicy(row.policy) : DEFAULT_REGISTRY_POLICY;
};

export const serverDetail = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  sourceId: string,
  name: string,
  version: string,
) => {
  const source = sourceOf(await registrySources.require(ctx, sourceId));
  const row = await findServer(ctx.deps, sourceId, name, version);
  const policy = await loadPolicy(ctx.deps, sourceId);
  const visible = isNamespaceAllowed(policy, name);
  // What is not shown to somebody does not exist for them (no hint of it in a refusal).
  if (!visible && !seesWholeRegistry(ctx.principal)) throw new NotFoundApiError('registry server');
  const mapping = safeMap(row);
  if (!mapping.installable) {
    return {
      ...serverSummary(row),
      visibleToMembers: visible,
      serverJson: row.serverJson,
      install: { installable: false, reasons: [mapping.detail] },
    };
  }
  const evaluation = evaluateInstall({
    policy,
    source,
    serverName: name,
    runtime: mapping.runtime,
    actor: actorOf(ctx.principal),
  });
  return {
    ...serverSummary(row),
    visibleToMembers: visible,
    serverJson: row.serverJson,
    install: {
      installable: true,
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      runtime: mapping.runtime,
      risk: evaluation.risk,
      form: mapping.form,
      warnings: mapping.warnings,
    },
  };
};

// --- install ------------------------------------------------------------------------------------------------------

type Planned = { row: RegistryServerRow; mapping: Extract<MappingResult, { installable: true }> };

const planFor = async (
  deps: ApiDeps,
  sourceId: string,
  name: string,
  version: string,
  prefer: 'remote' | 'package' | undefined,
): Promise<Planned> => {
  const row = await findServer(deps, sourceId, name, version);
  if (row.status === 'deleted') {
    throw new ConflictApiError(
      'this registry entry was deleted upstream',
      'registry_entry_deleted',
    );
  }
  const mapping = safeMap(row, prefer);
  if (!mapping.installable) {
    throw new ApiError('not_installable', mapping.detail, 422, {
      errors: [{ path: '/', message: mapping.reason }],
    });
  }
  return { row, mapping };
};

const reasonsToErrors = (reasons: readonly string[]) =>
  reasons.map((message) => ({ path: '/', message }));

const osvGate = async (deps: ApiDeps, spec: Planned['mapping']['spec'], policy: RegistryPolicy) => {
  const gate = await runOsvGate(spec, {
    requireOsvClean: policy.requireOsvClean,
    ...(deps.registry.fetch ? { fetch: deps.registry.fetch } : {}),
  });
  if (gate.clean) return;
  const detail =
    gate.malicious.length > 0
      ? gate.malicious.map(
          (m) => `${m.package.name}@${m.package.version}: ${m.advisoryIds.join(', ')}`,
        )
      : [gate.error ?? 'the OSV check failed'];
  throw new ApiError('osv_blocked', 'known-malicious packages block this install (11.7)', 422, {
    errors: reasonsToErrors(detail),
  });
};

const audit = (ctx: WriteCtx, e: RegistryAuditEvent) =>
  ctx.tx.audit({
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    diff: e.metadata,
  });

const uniqueSlug = async (
  ctx: WriteCtx,
  collection: 'catalog_entries' | 'installations',
  base: string,
  where: Record<string, unknown>,
): Promise<string> => {
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if ((await ctx.tx.store.find(collection, { ...where, slug })).length === 0) return slug;
  }
  throw new ConflictApiError('could not find a free slug');
};

/** Creates or reuses the catalog entry, pins the version and creates the installation (11.7). */
export const executePlan = async (
  ctx: WriteCtx,
  plan: InstallPlan,
  mapping: Planned['mapping'],
  trust: RegistryTrust,
): Promise<{ entry: Row; version: Row; installation: Row }> => {
  const { catalogEntry: ce } = plan;
  const store = ctx.tx.store;
  const key = {
    registrySourceId: ce.source.registrySourceId,
    registryServerName: ce.source.serverName,
  };
  let entry = (await store.find('catalog_entries', key))[0];
  if (!entry) {
    const slug = await uniqueSlug(ctx, 'catalog_entries', ce.slug, {});
    entry = await store.insert('catalog_entries', {
      id: ctx.deps.newId(),
      slug,
      kind: 'mcp_server',
      displayName: ce.displayName,
      description: ce.description,
      tags: [],
      ownerTeamId: null,
      visibility: ce.visibility,
      status: 'draft',
      risk: ce.risk,
      source: { kind: 'registry', ...ce.source, trust },
      ...key,
      currentVersionId: null,
      autoUpgrade: false,
      userOverrides: 'cosmetic',
      onDrift: 'hideChanged',
      createdBy: plan.installation.userId,
      createdAt: nowIso(ctx.deps),
    });
  } else if (!JSON.stringify(entry.visibility).includes(plan.installation.userId)) {
    const vis = (entry.visibility ?? { org: false, teamIds: [], userIds: [] }) as {
      org?: boolean;
      teamIds?: string[];
      userIds?: string[];
    };
    entry = await store.update('catalog_entries', entry.id, {
      visibility: { ...vis, userIds: [...(vis.userIds ?? []), plan.installation.userId] },
    });
  }
  let version = (
    await store.find('catalog_versions', { entryId: entry.id, label: ce.pinnedVersion })
  )[0];
  if (!version) {
    version = await store.insert('catalog_versions', {
      id: ctx.deps.newId(),
      entryId: entry.id,
      label: ce.pinnedVersion,
      serverSpec: mapping.spec,
      installForm: mapping.form,
      overrides: {},
      limits: [],
      runtime: { kind: ce.runtime },
      status: 'draft',
      testResult: null,
      createdBy: plan.installation.userId,
      createdAt: nowIso(ctx.deps),
    });
  }
  const slug = await uniqueSlug(
    ctx,
    'installations',
    entry.slug === undefined ? ce.slug : String(entry.slug),
    {
      ownerType: 'user',
      ownerId: plan.installation.userId,
    },
  );
  const needsSetup = mapping.form.variables.length > 0 || mapping.form.secrets.length > 0;
  const installation = await store.insert('installations', {
    id: ctx.deps.newId(),
    ownerType: 'user',
    ownerId: plan.installation.userId,
    catalogEntryId: entry.id,
    catalogVersionId: version.id,
    pinnedVersion: true,
    personalSpec: null,
    slug,
    toolPrefix: slugify(slug).replaceAll('-', '_'),
    displayName: ce.displayName,
    enabled: true,
    variables: {},
    secretRefs: {},
    overrides: {},
    origin: plan.installation.origin,
    status: needsSetup ? 'needs_setup' : 'ready',
    statusDetail: { automaticTest: plan.automaticTest },
    createdAt: nowIso(ctx.deps),
  });
  return { entry, version, installation };
};

const notify = async (
  ctx: WriteCtx,
  userId: string,
  title: string,
  data: Record<string, unknown>,
): Promise<void> => {
  const row = await ctx.tx.store.insert('notifications', {
    id: ctx.deps.newId(),
    userId,
    type: 'install_request',
    title,
    data,
    readAt: null,
    createdAt: nowIso(ctx.deps),
  });
  ctx.tx.emit({
    id: row.id,
    type: 'notification',
    audience: { userIds: [userId] },
    data: row,
  });
};

export type InstallOutcome =
  | { decision: 'installed'; reasons: string[]; entryId: string; installationId: string }
  | { decision: 'needs-request'; reasons: string[] };

/** `POST /registry/install` (11.7): evaluate the source policy, gate on OSV, then act on the decision. */
export const installFromRegistry = async (
  ctx: WriteCtx,
  body: {
    sourceId: string;
    name: string;
    version: string;
    prefer?: 'remote' | 'package' | undefined;
  },
): Promise<InstallOutcome> => {
  const source = sourceOf(await registrySources.require(ctx, body.sourceId));
  if (!source.enabled)
    throw new ConflictApiError('this registry source is disabled', 'source_disabled');
  const planned = await planFor(ctx.deps, body.sourceId, body.name, body.version, body.prefer);
  const policy = await loadPolicy(ctx.deps, body.sourceId);
  const evaluation: InstallEvaluation = evaluateInstall({
    policy,
    source,
    serverName: body.name,
    runtime: planned.mapping.runtime,
    actor: actorOf(ctx.principal),
  });
  switch (evaluation.decision) {
    case 'denied':
      throw new ForbiddenApiError(evaluation.reasons.join('; '), { reasons: evaluation.reasons });
    case 'catalog-only':
      throw new ApiError('catalog_only', 'policy only allows importing into the catalog', 409, {
        errors: reasonsToErrors(evaluation.reasons),
        data: { canImport: evaluation.canImport === true },
      });
    case 'needs-request':
      await ctx.tx.audit({
        action: 'registry.install.needs_request',
        targetType: 'registry_server',
        targetId: `${body.sourceId}:${body.name}@${body.version}`,
        diff: { reasons: evaluation.reasons },
      });
      return { decision: 'needs-request', reasons: evaluation.reasons };
    case 'allowed-direct': {
      await osvGate(ctx.deps, planned.mapping.spec, policy);
      const plan = buildInstallPlan({
        requesterId: ctx.principal.id,
        sourceId: body.sourceId,
        serverJson: planned.row.serverJson,
        version: body.version,
        risk: evaluation.risk,
        runtime: planned.mapping.runtime,
      });
      const created = await executePlan(ctx, plan, planned.mapping, source.trust);
      await audit(
        ctx,
        describeInstall({
          actorId: ctx.principal.id,
          sourceId: body.sourceId,
          serverName: body.name,
          version: body.version,
          runtime: planned.mapping.runtime,
          trust: source.trust,
          at: ctx.deps.clock.now(),
        }),
      );
      ctx.tx.configChanged('installations');
      return {
        decision: 'installed',
        reasons: evaluation.reasons,
        entryId: created.entry.id,
        installationId: created.installation.id,
      };
    }
  }
};

// --- install requests ---------------------------------------------------------------------------------------

const teamIdsOf = async (deps: ApiDeps, userId: string): Promise<string[]> =>
  (await deps.store.find('team_members', { userId })).map((m) => String(m.teamId));

/** Admins plus managers of the requester's teams, as approver candidates (11.7). */
const approverCandidates = async (
  ctx: WriteCtx,
  requesterTeams: string[],
): Promise<InstallActor[]> => {
  const out = new Map<string, InstallActor>();
  for (const admin of await ctx.tx.store.find('users', { orgRole: 'admin' })) {
    out.set(admin.id, { id: admin.id, orgRole: 'admin', managedTeamIds: [] });
  }
  for (const teamId of requesterTeams) {
    for (const m of await ctx.tx.store.find('team_members', { teamId, role: 'manager' })) {
      const userId = String(m.userId);
      const existing = out.get(userId);
      out.set(userId, {
        id: userId,
        orgRole: existing?.orgRole ?? 'member',
        managedTeamIds: [...(existing?.managedTeamIds ?? []), teamId],
      });
    }
  }
  return [...out.values()];
};

export const submitRequest = async (
  ctx: WriteCtx,
  body: { sourceId: string; name: string; version: string; justification: string },
): Promise<Row> => {
  await registrySources.require(ctx, body.sourceId);
  await planFor(ctx.deps, body.sourceId, body.name, body.version, undefined);
  const open = await ctx.tx.store.find('install_requests', {
    requesterId: ctx.principal.id,
    sourceId: body.sourceId,
    serverName: body.name,
    version: body.version,
    status: 'open',
  });
  if (open.length > 0) {
    throw new ConflictApiError(
      'you already have an open request for this server',
      'request_exists',
    );
  }
  const transition = createInstallRequest({
    id: ctx.deps.newId(),
    requesterId: ctx.principal.id,
    sourceId: body.sourceId,
    serverName: body.name,
    version: body.version,
    justification: body.justification,
    now: ctx.deps.clock.now(),
  });
  const row = await ctx.tx.store.insert('install_requests', {
    id: transition.request.id,
    ...requestFields(transition.request),
  });
  await audit(ctx, transition.audit);
  const teams = await teamIdsOf(ctx.deps, ctx.principal.id);
  const approvers = approverIds(await approverCandidates(ctx, teams), transition.request, teams);
  for (const id of approvers) {
    await notify(ctx, id, `Install request: ${body.name}`, { requestId: row.id });
  }
  return row;
};

/** Requesters see their own; managers those of their teams' members; admins all (11.7). */
export const listRequests = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  query: { limit: number; cursor?: string | undefined; status?: string | undefined },
) => {
  const actor = actorOf(ctx.principal);
  const where: Record<string, unknown> = {
    ...(query.status ? { status: query.status } : {}),
    ...(actor.orgRole === 'admin' || actor.managedTeamIds.length > 0
      ? {}
      : { requesterId: actor.id }),
  };
  const page = await ctx.deps.store.list('install_requests', {
    limit: query.limit,
    cursor: query.cursor,
    sort: { field: 'createdAt', desc: true },
    where,
  });
  if (actor.orgRole === 'admin' || actor.managedTeamIds.length === 0) return page;
  const items: Row[] = [];
  for (const row of page.items) {
    const requesterTeams = await teamIdsOf(ctx.deps, String(row.requesterId));
    if (
      row.requesterId === actor.id ||
      actor.managedTeamIds.some((t) => requesterTeams.includes(t))
    ) {
      items.push(row);
    }
  }
  return { items, nextCursor: page.nextCursor };
};

export const requestById = async (deps: ApiDeps, id: string): Promise<Row> => {
  const row = await deps.store.get('install_requests', id);
  if (!row) throw new NotFoundApiError('install request');
  return row;
};

export const approveInstallRequest = async (ctx: WriteCtx, id: string) => {
  const row = await requestById(ctx.deps, id);
  const request = requestOf(row);
  const source = sourceOf(await registrySources.require(ctx, request.sourceId));
  const planned = await planFor(
    ctx.deps,
    request.sourceId,
    request.serverName,
    request.version,
    undefined,
  );
  const policy = await loadPolicy(ctx.deps, request.sourceId);
  const approvalCtx: ApprovalContext = {
    actor: actorOf(ctx.principal),
    requesterTeamIds: await teamIdsOf(ctx.deps, request.requesterId),
    now: ctx.deps.clock.now(),
    serverJson: planned.row.serverJson,
    risk: riskFromTrust(source.trust),
    runtime: planned.mapping.runtime,
    trust: source.trust,
  };
  const outcome = approveRequest(request, approvalCtx);
  await osvGate(ctx.deps, planned.mapping.spec, policy);
  const created = await executePlan(ctx, outcome.plan, planned.mapping, source.trust);
  const updated = await ctx.tx.store.update('install_requests', id, requestFields(outcome.request));
  await audit(ctx, outcome.audit);
  await audit(ctx, outcome.installAudit);
  await notify(ctx, request.requesterId, `Approved: ${request.serverName}`, {
    requestId: id,
    installationId: created.installation.id,
  });
  ctx.tx.configChanged('installations');
  return updated;
};

export const rejectInstallRequest = async (ctx: WriteCtx, id: string, reason: string) => {
  const request = requestOf(await requestById(ctx.deps, id));
  const outcome = rejectRequest(request, {
    actor: actorOf(ctx.principal),
    requesterTeamIds: await teamIdsOf(ctx.deps, request.requesterId),
    now: ctx.deps.clock.now(),
    reason,
  });
  const updated = await ctx.tx.store.update('install_requests', id, requestFields(outcome.request));
  await audit(ctx, outcome.audit);
  await notify(ctx, request.requesterId, `Rejected: ${request.serverName}`, {
    requestId: id,
    reason,
  });
  return updated;
};

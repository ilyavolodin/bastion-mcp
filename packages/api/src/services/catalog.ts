import { PLUGIN_LIMITS, slugify } from '@bastion-mcp/core';
import {
  type ApprovalStatus,
  approvalStatus,
  classifyFile,
  type ExecutableDiffEntry,
  executableEntries,
  normalizePath,
  type PluginFile,
  type PluginManifest,
  pluginManifestSchema,
  requiresAdminApproval,
  reviewedDiff,
  reviewedDiffSha256,
  sortFiles,
} from '@bastion-mcp/plugins';
import {
  deriveInstallForm,
  importFromClientConfig,
  importFromServerJson,
  riskFromTrust,
} from '@bastion-mcp/registry';
import { ApiError, ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import type { ListQueryInput } from '../framework/conventions';
import type { ApiDeps } from '../ports';
import type { ImportedCatalogDraft, VersionTestRun } from '../ports/catalog';
import type { Collection, Page, Row } from '../ports/store';
import type { ImportBody } from '../schemas/catalog';
import { CrudService, nowIso, type ReadCtx, type WriteCtx } from './crud';
import { catalogEntryResource } from './resources';

export const entries = new CrudService({
  collection: 'catalog_entries',
  targetType: 'catalog_entry',
  action: 'catalog.entry',
  unique: 'slug',
  configTopic: 'catalog',
});

export const pluginSources = new CrudService({
  collection: 'plugin_sources',
  targetType: 'plugin_source',
  action: 'plugin_source',
  configTopic: 'plugin_sources',
});

type Deps = Pick<ReadCtx, 'deps'>;

// --- entries -------------------------------------------------------------------------------------------

const MAX_FILL_ROUNDS = 10;

/**
 * Pages a collection through a per-row visibility filter (Cedar `seeCatalog`, 11.1): keeps fetching until the
 * page is full or the collection is exhausted, so a filtered page is never short while more exist.
 */
export const visiblePage = async (
  ctx: Deps,
  collection: Collection,
  query: ListQueryInput,
  where: Record<string, unknown>,
  keep: (row: Row) => boolean,
): Promise<Page<Row>> => {
  const items: Row[] = [];
  let cursor = query.cursor;
  let nextCursor: string | null = null;
  for (let round = 0; round < MAX_FILL_ROUNDS; round += 1) {
    const page = await ctx.deps.store.list(collection, {
      limit: query.limit,
      cursor,
      q: query.q,
      sort: query.sort
        ? { field: query.sort.replace(/^-/, ''), desc: query.sort.startsWith('-') }
        : undefined,
      where,
    });
    for (const row of page.items) {
      if (keep(row) && items.length < query.limit) items.push(row);
    }
    nextCursor = page.nextCursor;
    if (items.length >= query.limit || nextCursor === null) break;
    cursor = nextCursor;
  }
  return { items, nextCursor };
};

const definedOnly = (obj: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

export const listEntries = (
  ctx: ReadCtx,
  query: ListQueryInput & {
    kind?: string | undefined;
    status?: string | undefined;
    ownerTeamId?: string | undefined;
  },
) =>
  visiblePage(
    ctx,
    'catalog_entries',
    query,
    definedOnly({ kind: query.kind, status: query.status, ownerTeamId: query.ownerTeamId }),
    (row) => ctx.can('seeCatalog', catalogEntryResource(row)),
  );

export const createEntry = (ctx: WriteCtx, body: Record<string, unknown>) =>
  entries.create(ctx, {
    ...body,
    ownerTeamId: body.ownerTeamId ?? null,
    status: 'draft',
    source: { kind: 'manual' },
    currentVersionId: null,
    createdBy: ctx.principal.id,
  });

export const deleteEntry = async (ctx: WriteCtx, id: string): Promise<void> => {
  const installs = await ctx.tx.store.find('installations', { catalogEntryId: id });
  if (installs.length > 0) {
    throw new ConflictApiError('the entry has installations; remove them first', 'entry_in_use');
  }
  for (const version of await ctx.tx.store.find('catalog_versions', { entryId: id })) {
    await dropVersionData(ctx, version.id);
    await ctx.tx.store.remove('catalog_versions', version.id);
  }
  await entries.remove(ctx, id);
};

const dropVersionData = async (ctx: WriteCtx, versionId: string): Promise<void> => {
  for (const file of await ctx.tx.store.find('catalog_files', { catalogVersionId: versionId })) {
    await ctx.tx.store.remove('catalog_files', file.id);
  }
  await ctx.tx.store.remove('executable_approvals', versionId);
};

// --- versions --------------------------------------------------------------------------------------------

export const requireVersion = async (
  ctx: Deps,
  entryId: string,
  versionId: string,
  store: Pick<ApiDeps['store'], 'get'> = ctx.deps.store,
): Promise<Row> => {
  const row = await store.get('catalog_versions', versionId);
  if (!row || row.entryId !== entryId) throw new NotFoundApiError('catalog version');
  return row;
};

export const listVersions = async (
  ctx: Deps,
  entryId: string,
  query: ListQueryInput,
): Promise<Page<Row>> => {
  await entries.require(ctx, entryId);
  return ctx.deps.store.list('catalog_versions', {
    limit: query.limit,
    cursor: query.cursor,
    q: query.q,
    sort: query.sort
      ? { field: query.sort.replace(/^-/, ''), desc: query.sort.startsWith('-') }
      : { field: 'createdAt', desc: true },
    where: { entryId },
  });
};

export const getVersion = async (ctx: Deps, entryId: string, versionId: string) => {
  const entry = await entries.require(ctx, entryId);
  const version = await requireVersion(ctx, entryId, versionId);
  const content = await loadContent(ctx.deps, entry, version.id);
  if (content.files.length === 0) return version;
  const status = await approvalOf(ctx.deps, entry, version.id, content);
  return { ...version, approval: status };
};

export const createVersion = async (
  ctx: WriteCtx,
  entryId: string,
  body: { label: string; serverSpec: unknown; installForm: unknown; changelog: string | null },
): Promise<Row> => {
  if (!(await ctx.tx.store.get('catalog_entries', entryId)))
    throw new NotFoundApiError('catalog entry');
  const clash = await ctx.tx.store.find('catalog_versions', { entryId, label: body.label });
  if (clash.length > 0)
    throw new ConflictApiError('this version label already exists', 'version_exists');
  const row = await ctx.tx.store.insert('catalog_versions', {
    id: ctx.deps.newId(),
    entryId,
    ...body,
    status: 'draft',
    testResult: null,
    createdBy: ctx.principal.id,
    createdAt: nowIso(ctx.deps),
  });
  await ctx.tx.audit({
    action: 'catalog.version.create',
    targetType: 'catalog_version',
    targetId: row.id,
    diff: { entryId, label: body.label },
  });
  ctx.tx.configChanged('catalog');
  return row;
};

const assertDraft = (version: Row): void => {
  if (version.status !== 'draft') {
    throw new ConflictApiError('published versions are immutable (11.1)', 'version_immutable');
  }
};

// --- plugin content and approval (25.2) ----------------------------------------------------------------------

export type VersionContent = { manifest: PluginManifest; files: PluginFile[] };

const defaultManifest = (entry: Row): PluginManifest =>
  pluginManifestSchema.parse({
    name: slugify(String(entry.slug ?? 'plugin')) || 'plugin',
    version: '0.0.0',
    description: String(entry.description || entry.displayName || 'plugin'),
    displayName: String(entry.displayName ?? 'plugin'),
  });

const fileModeOf = (value: unknown): PluginFile['mode'] =>
  value === 'executable' ? 'executable' : 'file';

export const loadContent = async (
  deps: ApiDeps,
  entry: Row,
  versionId: string,
): Promise<VersionContent> => {
  const rows = await deps.store.find('catalog_files', { catalogVersionId: versionId });
  const files: PluginFile[] = [];
  for (const row of rows) {
    const content = await deps.catalog.blobs.get(String(row.blobSha256));
    if (!content) throw new ApiError('blob_missing', `blob of ${String(row.path)} is missing`, 500);
    files.push({ path: String(row.path), content, mode: fileModeOf(row.mode) });
  }
  return { manifest: defaultManifest(entry), files: sortFiles(files) };
};

/** The newest published version of the entry with an approval: the baseline of the reviewed diff. */
const previouslyApproved = async (
  deps: ApiDeps,
  entry: Row,
  versionId: string,
): Promise<VersionContent | undefined> => {
  const versions = await deps.store.find('catalog_versions', {
    entryId: entry.id,
    status: 'published',
  });
  const ordered = versions
    .filter((v) => v.id !== versionId)
    .sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')));
  for (const v of ordered) {
    if (await deps.store.get('executable_approvals', v.id)) return loadContent(deps, entry, v.id);
  }
  return undefined;
};

export type ApprovalView = {
  status: ApprovalStatus;
  reviewedDiffSha256: string;
  executables: ReturnType<typeof executableEntries>;
  diff: ExecutableDiffEntry[];
};

export const approvalOf = async (
  deps: ApiDeps,
  entry: Row,
  versionId: string,
  content?: VersionContent,
): Promise<ApprovalView> => {
  const current = content ?? (await loadContent(deps, entry, versionId));
  const baseline = await previouslyApproved(deps, entry, versionId);
  const stored = await deps.store.get('executable_approvals', versionId);
  const digest = reviewedDiffSha256(baseline, current);
  const approval =
    stored && typeof stored.reviewedDiffSha256 === 'string'
      ? { reviewedDiffSha256: stored.reviewedDiffSha256 }
      : undefined;
  return {
    status: approvalStatus(current, baseline, approval),
    reviewedDiffSha256: digest,
    executables: executableEntries(current),
    diff: reviewedDiff(baseline, current),
  };
};

/** `POST .../approve-executable` (admin only, 10.1): binds the approval to the reviewed diff digest. */
export const approveExecutable = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  body: { note?: string | undefined; reviewedDiffSha256?: string | undefined },
): Promise<Row> => {
  const entry = await ctx.tx.store.get('catalog_entries', entryId);
  if (!entry) throw new NotFoundApiError('catalog entry');
  await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  const content = await loadContent(ctx.deps, entry, versionId);
  if (!requiresAdminApproval(content)) {
    throw new ConflictApiError('this version has no executable content', 'approval_not_required');
  }
  const view = await approvalOf(ctx.deps, entry, versionId, content);
  if (
    body.reviewedDiffSha256 !== undefined &&
    body.reviewedDiffSha256 !== view.reviewedDiffSha256
  ) {
    throw new ConflictApiError(
      'the executable content changed since it was reviewed',
      'stale_review',
    );
  }
  const row = await ctx.tx.store.upsert('executable_approvals', versionId, {
    catalogVersionId: versionId,
    approvedBy: ctx.principal.id,
    reviewedDiffSha256: view.reviewedDiffSha256,
    note: body.note ?? null,
    approvedAt: nowIso(ctx.deps),
  });
  await ctx.tx.audit({
    action: 'plugin.executable.approve',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: { reviewedDiffSha256: view.reviewedDiffSha256, paths: view.diff.map((d) => d.path) },
  });
  return { ...row, status: 'approved', paths: view.executables.map((e) => e.path) };
};

// --- publishing (11.1, 11.2) ---------------------------------------------------------------------------------

export const publishVersion = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  body: { visibility?: { org: boolean; teamIds: string[]; userIds: string[] } | undefined },
): Promise<Row> => {
  const entry = await ctx.tx.store.get('catalog_entries', entryId);
  if (!entry) throw new NotFoundApiError('catalog entry');
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  const test = version.testResult as { status?: unknown } | null;
  if (test?.status !== 'passed') {
    throw new ConflictApiError(
      'the version must pass its automatic test first (11.2)',
      'test_required',
    );
  }
  const content = await loadContent(ctx.deps, entry, versionId);
  if (content.files.length > 0) {
    const view = await approvalOf(ctx.deps, entry, versionId, content);
    if (view.status !== 'not-required' && view.status !== 'approved') {
      throw new ConflictApiError(
        `executable content needs an Admin approval (${view.status})`,
        'approval_required',
      );
    }
  }
  const published = await ctx.tx.store.update('catalog_versions', versionId, {
    status: 'published',
    publishedAt: nowIso(ctx.deps),
  });
  await ctx.tx.store.update('catalog_entries', entryId, {
    status: 'published',
    currentVersionId: versionId,
    ...(body.visibility ? { visibility: body.visibility } : {}),
  });
  await ctx.tx.audit({
    action: 'catalog.version.publish',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: {
      entryId,
      label: version.label,
      ...(body.visibility ? { visibility: body.visibility } : {}),
    },
  });
  ctx.tx.configChanged('catalog');
  return published;
};

// --- automatic test (11.2) ---------------------------------------------------------------------------------

export const startTest = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
): Promise<VersionTestRun> => {
  await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  const run = await ctx.deps.catalog.tests.start({
    entryId,
    versionId,
    requestedBy: ctx.principal.id,
  });
  await ctx.tx.audit({
    action: 'catalog.version.test',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: { runId: run.id },
  });
  return run;
};

export const latestTest = async (ctx: Deps, entryId: string, versionId: string) => {
  await requireVersion(ctx, entryId, versionId);
  return ctx.deps.catalog.tests.latest(versionId);
};

// --- files (25.2) -----------------------------------------------------------------------------------------

const decodeBase64 = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ValidationApiError('contentBase64 is not valid base64', [
      { path: '/contentBase64', message: 'invalid base64' },
    ]);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > PLUGIN_LIMITS.maxFileBytes) {
    throw new ApiError(
      'file_too_large',
      `files are limited to ${PLUGIN_LIMITS.maxFileBytes} bytes`,
      413,
    );
  }
  return new Uint8Array(bytes);
};

const fileView = (row: Row) => ({
  id: row.id,
  path: row.path,
  mode: row.mode,
  classification: row.classification,
  sha256: row.blobSha256,
  size: row.size ?? null,
  updatedAt: row.updatedAt,
});

export const fileRowId = (versionId: string, path: string): string => `${versionId}:${path}`;

export const listFiles = async (ctx: Deps, entryId: string, versionId: string) => {
  const entry = await entries.require(ctx, entryId);
  await requireVersion(ctx, entryId, versionId);
  const rows = await ctx.deps.store.find('catalog_files', { catalogVersionId: versionId });
  const items = rows.map(fileView).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const approval = items.length > 0 ? await approvalOf(ctx.deps, entry, versionId) : null;
  return { items, nextCursor: null, approval };
};

export const getFile = async (ctx: Deps, entryId: string, versionId: string, rawPath: string) => {
  await requireVersion(ctx, entryId, versionId);
  const path = normalizePath(rawPath);
  const row = await ctx.deps.store.get('catalog_files', fileRowId(versionId, path));
  if (!row) throw new NotFoundApiError('file');
  const bytes = await ctx.deps.catalog.blobs.get(String(row.blobSha256));
  if (!bytes) throw new ApiError('blob_missing', 'the file content is missing', 500);
  return { ...fileView(row), contentBase64: Buffer.from(bytes).toString('base64') };
};

export const putFile = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  rawPath: string,
  body: { contentBase64: string; mode: 'file' | 'executable' },
) => {
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  const path = normalizePath(rawPath);
  const content = decodeBase64(body.contentBase64);
  const classified = classifyFile({ path, content, mode: body.mode });
  const sha = await ctx.deps.catalog.blobs.put(content);
  const row = await ctx.tx.store.upsert('catalog_files', fileRowId(versionId, path), {
    catalogVersionId: versionId,
    path,
    blobSha256: sha,
    mode: body.mode,
    classification: classified.classification,
    size: content.length,
  });
  // A changed file invalidates any earlier approval: it must be reviewed again (25.2).
  await ctx.tx.store.remove('executable_approvals', versionId);
  await ctx.tx.audit({
    action: 'catalog.file.put',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: {
      path,
      sha256: sha,
      classification: classified.classification,
      reason: classified.reason,
    },
  });
  return fileView(row);
};

export const deleteFile = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  rawPath: string,
): Promise<void> => {
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  const path = normalizePath(rawPath);
  const removed = await ctx.tx.store.remove('catalog_files', fileRowId(versionId, path));
  if (!removed) throw new NotFoundApiError('file');
  await ctx.tx.store.remove('executable_approvals', versionId);
  await ctx.tx.audit({
    action: 'catalog.file.delete',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: { path },
  });
};

// --- import (11.3, 25.2) -----------------------------------------------------------------------------------

type Draft = {
  kind: 'mcp_server' | 'skill' | 'plugin';
  name: string;
  description: string;
  spec: unknown;
  installForm: unknown;
  risk: 'low' | 'medium' | 'high';
  label: string;
  files: Array<{ path: string; content: Uint8Array }>;
  source: Record<string, unknown>;
  warnings: string[];
};

const lastSegment = (name: string): string => name.split('/').pop() ?? name;

const unsupported = (detail: string) => new ApiError('unsupported_server', detail, 422);

const fromServerJson = (input: unknown, prefer: 'remote' | 'package' | undefined): Draft => {
  const { serverJson, mapping } = importFromServerJson(input, prefer ? { prefer } : {});
  if (!mapping.installable) throw unsupported(mapping.detail);
  return {
    kind: 'mcp_server',
    name: serverJson.title ?? lastSegment(serverJson.name),
    description: serverJson.description,
    spec: mapping.spec,
    installForm: mapping.form,
    risk: 'medium',
    label: serverJson.version,
    files: [],
    source: { kind: 'server_json', serverName: serverJson.name, version: serverJson.version },
    warnings: mapping.warnings,
  };
};

const fromDraftFiles = (draft: ImportedCatalogDraft, source: Record<string, unknown>): Draft => ({
  kind: draft.kind,
  name: draft.name,
  description: draft.description ?? '',
  spec: draft.spec ?? null,
  installForm: draft.spec ? deriveInstallForm(draft.spec) : { variables: [], secrets: [] },
  risk: 'medium',
  label: '1',
  files: (draft.files ?? []).map((f) => ({
    path: normalizePath(f.path),
    content: decodeBase64(f.contentBase64),
  })),
  source,
  warnings: draft.warnings,
});

const resolveDraft = async (
  ctx: WriteCtx,
  source: ImportBody,
  signal?: AbortSignal,
): Promise<Draft> => {
  const { deps } = ctx;
  switch (source.kind) {
    case 'server_json':
      return fromServerJson(source.serverJson, source.prefer);
    case 'client_config': {
      const imported = await importFromClientConfig(source.snippet, {
        resolver: deps.catalog.versions,
        ...(signal ? { signal } : {}),
      });
      return {
        kind: 'mcp_server',
        name: source.name ?? imported.name,
        description: imported.description ?? '',
        spec: imported.spec,
        installForm: deriveInstallForm(imported.spec),
        risk: 'medium',
        label: '1',
        files: [],
        source: { kind: 'client_config' },
        warnings: imported.warnings,
      };
    }
    case 'registry': {
      const registry = await deps.registry.sources.get(source.sourceId);
      if (!registry) throw new NotFoundApiError('registry source');
      const rows = await deps.registry.servers.list(source.sourceId, { name: source.name });
      const row = rows.find((r) => r.version === source.version);
      if (!row) throw new NotFoundApiError('registry server');
      const draft = fromServerJson(row.serverJson, undefined);
      return {
        ...draft,
        risk: riskFromTrust(registry.trust),
        source: {
          kind: 'registry',
          registrySourceId: source.sourceId,
          serverName: source.name,
          version: source.version,
        },
      };
    }
    case 'zip':
      return fromDraftFiles(
        await deps.catalog.imports.fromZip(decodeBase64(source.contentBase64)),
        {
          kind: 'zip',
        },
      );
    case 'git':
      return fromDraftFiles(await deps.catalog.imports.fromGit(source.url, source.ref), {
        kind: 'git',
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
      });
  }
};

const uniqueSlug = async (ctx: WriteCtx, wanted: string): Promise<string> => {
  const base = slugify(wanted) || 'entry';
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if ((await ctx.tx.store.find('catalog_entries', { slug: candidate })).length === 0)
      return candidate;
  }
  throw new ConflictApiError('could not find a free slug', 'slug_taken');
};

/** `POST /catalog/import`: creates a draft entry and version from any supported source (11.3, 25.2). */
export const importEntry = async (
  ctx: WriteCtx,
  body: {
    ownerTeamId?: string | null | undefined;
    visibility?: { org: boolean; teamIds: string[]; userIds: string[] } | undefined;
    slug?: string | undefined;
    source: ImportBody;
  },
  signal?: AbortSignal,
) => {
  const draft = await resolveDraft(ctx, body.source, signal);
  const slug = body.slug ? await uniqueSlug(ctx, body.slug) : await uniqueSlug(ctx, draft.name);
  const entry = await ctx.tx.store.insert('catalog_entries', {
    id: ctx.deps.newId(),
    slug,
    kind: draft.kind,
    displayName: draft.name,
    description: draft.description,
    tags: [],
    ownerTeamId: body.ownerTeamId ?? null,
    visibility: body.visibility ?? { org: false, teamIds: [], userIds: [] },
    status: 'draft',
    risk: draft.risk,
    source: draft.source,
    currentVersionId: null,
    autoUpgrade: true,
    userOverrides: 'cosmetic',
    onDrift: 'hideChanged',
    createdBy: ctx.principal.id,
    createdAt: nowIso(ctx.deps),
  });
  const version = await ctx.tx.store.insert('catalog_versions', {
    id: ctx.deps.newId(),
    entryId: entry.id,
    label: draft.label,
    serverSpec: draft.spec,
    installForm: draft.installForm,
    status: 'draft',
    changelog: null,
    testResult: null,
    createdBy: ctx.principal.id,
    createdAt: nowIso(ctx.deps),
  });
  for (const file of draft.files) {
    const mode = file.content[0] === 0x23 && file.content[1] === 0x21 ? 'executable' : 'file';
    const classified = classifyFile({ path: file.path, content: file.content, mode });
    const sha = await ctx.deps.catalog.blobs.put(file.content);
    await ctx.tx.store.upsert('catalog_files', fileRowId(version.id, file.path), {
      catalogVersionId: version.id,
      path: file.path,
      blobSha256: sha,
      mode,
      classification: classified.classification,
      size: file.content.length,
    });
  }
  await ctx.tx.audit({
    action: 'catalog.import',
    targetType: 'catalog_entry',
    targetId: entry.id,
    diff: { source: draft.source, files: draft.files.length },
  });
  ctx.tx.configChanged('catalog');
  return { entry, version, warnings: draft.warnings };
};

// --- plugin sources (25.2) ---------------------------------------------------------------------------------

export const syncPluginSource = async (ctx: WriteCtx, id: string) => {
  if (!(await ctx.tx.store.get('plugin_sources', id))) throw new NotFoundApiError('plugin source');
  const result = await ctx.deps.plugins.syncSource(id);
  const row = await ctx.tx.store.update('plugin_sources', id, {
    lastSync: { at: nowIso(ctx.deps), ...result, ok: result.errors.length === 0 },
  });
  await ctx.tx.audit({
    action: 'plugin_source.sync',
    targetType: 'plugin_source',
    targetId: id,
    diff: { imported: result.imported, updated: result.updated, errors: result.errors.length },
  });
  return row;
};

// --- store (11.1) -------------------------------------------------------------------------------------------

const storeView = (row: Row) => ({
  id: row.id,
  slug: row.slug,
  kind: row.kind,
  displayName: row.displayName,
  description: row.description,
  tags: row.tags ?? [],
  risk: row.risk,
  ownerTeamId: row.ownerTeamId ?? null,
  currentVersionId: row.currentVersionId ?? null,
  updatedAt: row.updatedAt,
});

export const listStore = async (
  ctx: ReadCtx,
  query: ListQueryInput & { kind?: string | undefined },
) => {
  const page = await visiblePage(
    ctx,
    'catalog_entries',
    query,
    definedOnly({ status: 'published', kind: query.kind }),
    (row) => ctx.can('seeCatalog', catalogEntryResource(row)),
  );
  return { items: page.items.map(storeView), nextCursor: page.nextCursor };
};

/** Entries the caller may not see are 404, never 403 (11.1). */
export const getStoreEntry = async (ctx: ReadCtx, slug: string) => {
  const [row] = await ctx.deps.store.find('catalog_entries', { slug, status: 'published' });
  if (!row || !ctx.can('seeCatalog', catalogEntryResource(row)))
    throw new NotFoundApiError('entry');
  const current =
    typeof row.currentVersionId === 'string'
      ? await ctx.deps.store.get('catalog_versions', row.currentVersionId)
      : null;
  return {
    ...storeView(row),
    version: current
      ? {
          id: current.id,
          label: current.label,
          changelog: current.changelog ?? null,
          installForm: current.installForm,
          publishedAt: current.publishedAt ?? null,
        }
      : null,
  };
};

export type { PluginManifest };

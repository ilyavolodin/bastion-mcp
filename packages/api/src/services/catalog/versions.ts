import { slugify } from '@bastion-mcp/core';
import {
  type ApprovalStatus,
  approvalStatus,
  type ExecutableDiffEntry,
  executableEntries,
  type PluginFile,
  type PluginManifest,
  pluginManifestSchema,
  requiresAdminApproval,
  reviewedDiff,
  reviewedDiffSha256,
  sortFiles,
} from '@bastion-mcp/plugins';
import { ApiError, ConflictApiError, NotFoundApiError } from '../../errors';
import type { ListQueryInput } from '../../framework/conventions';
import type { ApiDeps } from '../../ports';
import type { VersionTestRun } from '../../ports/catalog';
import type { Page, Row } from '../../ports/store';
import { nowIso, type WriteCtx } from '../crud';

import { entries } from './entries';
import type { Deps } from './shared';

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
    throw new ConflictApiError('this version label already exists', { code: 'version_exists' });
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

export const updateVersion = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  body: {
    label?: string | undefined;
    serverSpec?: unknown;
    installForm?: unknown;
    changelog?: string | null | undefined;
  },
): Promise<Row> => {
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  if (body.label !== undefined && body.label !== version.label) {
    const clash = await ctx.tx.store.find('catalog_versions', { entryId, label: body.label });
    if (clash.length > 0)
      throw new ConflictApiError('this version label already exists', { code: 'version_exists' });
  }
  const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const row = await ctx.tx.store.update('catalog_versions', versionId, {
    ...changes,
    // A changed spec invalidates the earlier automatic test (11.2).
    ...(body.serverSpec === undefined ? {} : { testResult: null }),
  });
  await ctx.tx.audit({
    action: 'catalog.version.update',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: { entryId, changed: Object.keys(changes) },
  });
  ctx.tx.configChanged('catalog');
  return row;
};

export const assertDraft = (version: Row): void => {
  if (version.status !== 'draft') {
    throw new ConflictApiError('published versions are immutable (11.1)', {
      code: 'version_immutable',
    });
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
    throw new ConflictApiError('this version has no executable content', {
      code: 'approval_not_required',
    });
  }
  const view = await approvalOf(ctx.deps, entry, versionId, content);
  if (
    body.reviewedDiffSha256 !== undefined &&
    body.reviewedDiffSha256 !== view.reviewedDiffSha256
  ) {
    throw new ConflictApiError('the executable content changed since it was reviewed', {
      code: 'stale_review',
    });
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
    throw new ConflictApiError('the version must pass its automatic test first (11.2)', {
      code: 'test_required',
    });
  }
  const content = await loadContent(ctx.deps, entry, versionId);
  if (content.files.length > 0) {
    const view = await approvalOf(ctx.deps, entry, versionId, content);
    if (view.status !== 'not-required' && view.status !== 'approved') {
      throw new ConflictApiError(`executable content needs an Admin approval (${view.status})`, {
        code: 'approval_required',
      });
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
  variables?: Record<string, string>,
): Promise<VersionTestRun> => {
  await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  const run = await ctx.deps.catalog.tests.start({
    entryId,
    versionId,
    requestedBy: ctx.principal.id,
    ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
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

import { omitUndefined, TEST_ORIGIN } from '@bastion-mcp/core';
import { z } from 'zod';
import { ConflictApiError, NotFoundApiError } from '../../errors';
import { type ListQueryInput, toListQuery } from '../../framework/conventions';
import type { Collection, Page, Row } from '../../ports/store';
import { CrudService, nowIso, type ReadCtx, type WriteCtx } from '../crud';
import { catalogEntryResource } from '../resources';

import type { Deps } from './shared';

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
    // Ask only for what still fits, so every fetched row is consumed and the cursor never skips one.
    const page = await ctx.deps.store.list(
      collection,
      toListQuery({ ...query, limit: query.limit - items.length, cursor }, where),
    );
    for (const row of page.items) {
      if (keep(row)) items.push(row);
    }
    nextCursor = page.nextCursor;
    if (items.length >= query.limit || nextCursor === null) break;
    cursor = nextCursor;
  }
  return { items, nextCursor };
};

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
    omitUndefined({ kind: query.kind, status: query.status, ownerTeamId: query.ownerTeamId }),
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Deletes an entry with its versions, files and approvals (11.1). Hidden test installations (`origin: 'test'`, left
 * behind by the TEST flow, 11.3) do not count: they are stopped and removed with the entry. Real installations block
 * the delete with guidance: deprecate the entry to hide it, or remove the installations first.
 */
export const deleteEntry = async (ctx: WriteCtx, id: string): Promise<void> => {
  const installs = await ctx.tx.store.find('installations', { catalogEntryId: id });
  const real = installs.filter((i) => i.origin !== TEST_ORIGIN);
  if (real.length > 0) {
    throw new ConflictApiError(
      `${plural(real.length, 'installation')} use${real.length === 1 ? 's' : ''} this entry, so it cannot be deleted. ` +
        'Deprecate it to hide it from the Store, or remove the installations first.',
      { code: 'entry_in_use', data: { installations: real.length } },
    );
  }
  for (const install of installs) await dropTestInstallation(ctx, install);
  for (const version of await ctx.tx.store.find('catalog_versions', { entryId: id })) {
    await dropVersionData(ctx, version.id);
    await ctx.tx.store.remove('catalog_versions', version.id);
  }
  await entries.remove(ctx, id);
};

const secretRefsSchema = z.record(
  z.string(),
  z.object({ scope: z.string(), name: z.string() }).nullable(),
);

/** Stops the test instance and drops its secrets, then the row (prefs, instance rows and tokens cascade). */
const dropTestInstallation = async (ctx: WriteCtx, install: Row): Promise<void> => {
  await ctx.deps.installations.runtime.stop(install.id);
  const refs = secretRefsSchema.safeParse(install.secretRefs);
  const ownerId = typeof install.ownerId === 'string' ? install.ownerId : null;
  for (const ref of refs.success ? Object.values(refs.data) : []) {
    if (ref && (ref.scope === 'user' || ref.scope === 'team')) {
      await ctx.deps.secrets
        .delete({ scope: ref.scope, ownerId, name: ref.name })
        .catch(() => undefined);
    }
  }
  await ctx.tx.store.remove('installations', install.id);
};

const STATUS_FROM: Record<'deprecated' | 'archived', string[]> = {
  deprecated: ['published'],
  archived: ['published', 'deprecated'],
};

/**
 * `PATCH /catalog/{id}`. A status change is a lifecycle step (11.1): a published entry is deprecated (hidden from the
 * Store, existing installations keep working) and a published or deprecated one is archived. Drafts are deleted
 * instead, and nothing returns to `published` except publishing a version.
 */
export const updateEntry = async (
  ctx: WriteCtx,
  id: string,
  body: Record<string, unknown>,
): Promise<Row> => {
  const status = body.status;
  if (status === 'deprecated' || status === 'archived') {
    const current = await ctx.tx.store.get('catalog_entries', id);
    if (!current) throw new NotFoundApiError('catalog entry');
    if (!STATUS_FROM[status].includes(String(current.status))) {
      throw new ConflictApiError(
        `a ${String(current.status)} entry cannot be ${status}; ${
          current.status === 'draft'
            ? 'delete the draft instead'
            : 'only published or deprecated entries can change status'
        }`,
        { code: 'invalid_status' },
      );
    }
    const row = await entries.update(ctx, id, body);
    await ctx.tx.audit({
      action: `catalog.entry.${status === 'deprecated' ? 'deprecate' : 'archive'}`,
      targetType: 'catalog_entry',
      targetId: id,
      diff: { from: current.status, to: status },
    });
    return row;
  }
  return entries.update(ctx, id, body);
};

const dropVersionData = async (ctx: WriteCtx, versionId: string): Promise<void> => {
  for (const file of await ctx.tx.store.find('catalog_files', { catalogVersionId: versionId })) {
    await ctx.tx.store.remove('catalog_files', file.id);
  }
  await ctx.tx.store.remove('executable_approvals', versionId);
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
    omitUndefined({ status: 'published', kind: query.kind }),
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

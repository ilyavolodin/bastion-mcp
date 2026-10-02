import { z } from 'zod';
import { listQuerySchema, pageSchema } from '../framework/conventions';
import {
  type AuthzInput,
  authz,
  defineMutation,
  defineRoute,
  defineStream,
  type RouteDefinition,
  RouteReply,
} from '../framework/route';
import {
  approveBodySchema,
  entryCreateSchema,
  entryListQuery,
  entryPatchSchema,
  fileBodySchema,
  fileParams,
  importEnvelopeSchema,
  pluginSourceCreateSchema,
  pluginSourcePatchSchema,
  publishBodySchema,
  slugParams,
  storeListQuery,
  testStartBodySchema,
  versionCreateSchema,
  versionParams,
  versionPatchSchema,
  visibilityBodySchema,
} from '../schemas/catalog';
import { idParams } from '../schemas/common';
import {
  asRow,
  catalogEntryRow,
  catalogFileContent,
  catalogFileList,
  catalogFileRow,
  catalogVersionDetailRow,
  catalogVersionRow,
  executableApprovalRow,
  importResult,
  pageOf,
  pluginSourceRow,
  storeEntry,
  storeEntryDetail,
  untyped,
  versionTestRun,
} from '../schemas/rows';
import {
  approveExecutable,
  createEntry,
  createVersion,
  deleteEntry,
  deleteFile,
  entries,
  fileRowId,
  getFile,
  getStoreEntry,
  getVersion,
  importEntry,
  latestTest,
  listEntries,
  listFiles,
  listStore,
  listVersions,
  pluginSources,
  publishVersion,
  putFile,
  startTest,
  syncPluginSource,
  updateEntry,
  updateVersion,
} from '../services/catalog';
import {
  loadCatalogEntryResource,
  orgResource,
  orMissing,
  teamResource,
} from '../services/resources';
import { org, versionOf } from './shared';

const TAG = 'Catalog';
const PLUGIN_TAG = 'Skills and plugins';

const entryRes = async (i: AuthzInput) =>
  orMissing(await loadCatalogEntryResource(i.deps, i.params.id ?? ''));

const ownerOf = (body: unknown): string | null => {
  const owner = (body as { ownerTeamId?: unknown } | null | undefined)?.ownerTeamId;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
};

/** Team-owned entries authorize on that Team, org-owned ones on the Org (ROUTE_ACTIONS notes). */
const createAuthz = authz.oneOf(['catalog.create.team', 'catalog.create.org'], ({ body }) => {
  const owner = ownerOf(body);
  return owner
    ? { rule: 'catalog.create.team', resource: teamResource(owner) }
    : { rule: 'catalog.create.org', resource: orgResource() };
});

/** Publishing to team T authorizes on T; org-wide visibility authorizes on the Org (10.1). */
const publishAuthz = authz.oneOf(
  ['catalog.publish.team', 'catalog.publish.org'],
  async ({ deps, params, body }) => {
    const row = await deps.store.get('catalog_entries', params.id ?? '');
    const given = visibilityBodySchema.safeParse(
      (body as { visibility?: unknown } | null | undefined)?.visibility,
    );
    const orgWide = given.success ? given.data.org : catalogOrgWide(row?.visibility);
    const team = typeof row?.ownerTeamId === 'string' ? row.ownerTeamId : null;
    if (!orgWide && team) return { rule: 'catalog.publish.team', resource: teamResource(team) };
    return { rule: 'catalog.publish.org', resource: orgResource() };
  },
);

const catalogOrgWide = (visibility: unknown): boolean =>
  (visibility as { org?: unknown } | null | undefined)?.org === true;

const fileVersion = (input: AuthzInput) =>
  input.deps.store
    .get('catalog_files', fileRowId(input.params.vid ?? '', input.params.path ?? ''))
    .then((row) => row?.updatedAt ?? null);

const _runSchema = z.looseObject({ id: z.string(), versionId: z.string(), status: z.string() });
const idLoose = z.looseObject({ id: z.string() });
const _filesSchema = pageSchema(idLoose).extend({ approval: z.looseObject({}).nullable() });
const _storeItem = idLoose;

export const catalogRoutes: RouteDefinition[] = [
  // --- entries --------------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/catalog',
    tag: TAG,
    summary: 'List catalog entries visible to the caller',
    schema: { query: entryListQuery, response: pageOf('CatalogEntryPage', catalogEntryRow) },
    authz: authz.filter('catalog.read'),
    handler: (ctx) => listEntries(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog',
    tag: TAG,
    summary: 'Create a draft catalog entry',
    schema: { body: entryCreateSchema, response: asRow(catalogEntryRow) },
    authz: createAuthz,
    handler: (ctx) => createEntry(ctx, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog/import',
    tag: TAG,
    summary: 'Import server.json, a client config snippet, a registry server, a zip or a git URL',
    schema: { body: importEnvelopeSchema, response: untyped(importResult) },
    authz: createAuthz,
    handler: (ctx) => importEntry(ctx, ctx.body, ctx.signal),
  }),
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}',
    tag: TAG,
    summary: 'Get a catalog entry',
    schema: { params: idParams, response: asRow(catalogEntryRow) },
    authz: authz.on('catalog.read', entryRes),
    handler: (ctx) => entries.get(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/catalog/{id}',
    tag: TAG,
    summary: 'Update a catalog entry, or deprecate or archive a published one',
    schema: { params: idParams, body: entryPatchSchema, response: asRow(catalogEntryRow) },
    authz: authz.on('catalog.update', entryRes),
    version: versionOf('catalog_entries'),
    handler: (ctx) => updateEntry(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/catalog/{id}',
    tag: TAG,
    summary: 'Delete a catalog entry (409 while real installations use it)',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('catalog.delete', entryRes),
    status: 204,
    version: versionOf('catalog_entries'),
    handler: async (ctx) => {
      await deleteEntry(ctx, ctx.params.id);
      return null;
    },
  }),

  // --- versions -------------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions',
    tag: TAG,
    summary: 'List versions of an entry',
    schema: {
      params: idParams,
      query: listQuerySchema,
      response: pageOf('CatalogVersionPage', catalogVersionRow),
    },
    authz: authz.on('catalog.read', entryRes),
    handler: (ctx) => listVersions(ctx, ctx.params.id, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog/{id}/versions',
    tag: TAG,
    summary: 'Create a draft version',
    schema: { params: idParams, body: versionCreateSchema, response: asRow(catalogVersionRow) },
    authz: authz.on('catalog.update', entryRes),
    handler: (ctx) => createVersion(ctx, ctx.params.id, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions/{vid}',
    tag: TAG,
    summary: 'Get a version',
    schema: { params: versionParams, response: untyped(catalogVersionDetailRow) },
    authz: authz.on('catalog.read', entryRes),
    handler: (ctx) => getVersion(ctx, ctx.params.id, ctx.params.vid),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/catalog/{id}/versions/{vid}',
    tag: TAG,
    summary: 'Edit a draft version in place (published versions are immutable)',
    schema: { params: versionParams, body: versionPatchSchema, response: asRow(catalogVersionRow) },
    authz: authz.on('catalog.update', entryRes),
    version: versionOf('catalog_versions', 'vid'),
    handler: (ctx) => updateVersion(ctx, ctx.params.id, ctx.params.vid, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog/{id}/versions/{vid}/test',
    tag: TAG,
    summary: 'Start the automatic test of a version',
    schema: { params: versionParams, body: testStartBodySchema, response: versionTestRun },
    authz: authz.on('catalog.update', entryRes),
    status: 202,
    handler: async (ctx) =>
      new RouteReply(
        await startTest(
          ctx,
          ctx.params.id,
          ctx.params.vid,
          (ctx.body as { variables?: Record<string, string> }).variables,
        ),
        { status: 202 },
      ),
  }),
  defineStream({
    url: '/catalog/{id}/versions/{vid}/test',
    tag: TAG,
    summary: 'Stream the progress of the latest test run (SSE)',
    schema: { params: versionParams },
    authz: authz.on('catalog.read', entryRes),
    handler: async (ctx) => {
      const run = await latestTest(ctx, ctx.params.id, ctx.params.vid);
      const versionId = ctx.params.vid;
      // Nothing to follow when no run exists or the latest one is over: send it and end.
      const finished = run === null || run.status !== 'running';
      return {
        initial: run ? [{ event: 'run', data: run, id: run.id }] : [{ event: 'idle', data: {} }],
        subscribe: (emit, end) => {
          if (finished) {
            queueMicrotask(end);
            return () => {};
          }
          return ctx.deps.events.subscribe((event) => {
            if (event.type !== 'test.progress' || event.topic !== versionId) return;
            emit({ event: 'progress', data: event.data, id: event.id });
            const status = (event.data as { status?: unknown } | null)?.status;
            if (status === 'passed' || status === 'failed') end();
          });
        },
      };
    },
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog/{id}/versions/{vid}/publish',
    tag: TAG,
    summary: 'Publish a tested draft version',
    schema: { params: versionParams, body: publishBodySchema, response: asRow(catalogVersionRow) },
    authz: publishAuthz,
    status: 200,
    handler: (ctx) => publishVersion(ctx, ctx.params.id, ctx.params.vid, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/catalog/{id}/versions/{vid}/approve-executable',
    tag: PLUGIN_TAG,
    summary: 'Approve the executable content of a plugin version (Admin only)',
    schema: {
      params: versionParams,
      body: approveBodySchema,
      response: asRow(executableApprovalRow),
    },
    authz: authz.on('plugin.approve-executable', entryRes),
    status: 200,
    handler: (ctx) => approveExecutable(ctx, ctx.params.id, ctx.params.vid, ctx.body),
  }),

  // --- files ----------------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions/{vid}/files',
    tag: PLUGIN_TAG,
    summary: 'List the files of a skill or plugin version with their classification',
    schema: { params: versionParams, response: untyped(catalogFileList) },
    authz: authz.on('catalog.read', entryRes),
    handler: (ctx) => listFiles(ctx, ctx.params.id, ctx.params.vid),
  }),
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions/{vid}/files/{path}',
    tag: PLUGIN_TAG,
    summary: 'Read one file (path is URL-encoded)',
    schema: { params: fileParams, response: untyped(catalogFileContent) },
    authz: authz.on('catalog.read', entryRes),
    handler: (ctx) => getFile(ctx, ctx.params.id, ctx.params.vid, ctx.params.path),
  }),
  defineMutation({
    method: 'PUT',
    url: '/catalog/{id}/versions/{vid}/files/{path}',
    tag: PLUGIN_TAG,
    summary: 'Create or replace a file of a draft version',
    schema: {
      params: fileParams,
      body: fileBodySchema,
      response: untyped(catalogFileRow),
    },
    authz: authz.on('catalog.update', entryRes),
    version: fileVersion,
    handler: (ctx) => putFile(ctx, ctx.params.id, ctx.params.vid, ctx.params.path, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/catalog/{id}/versions/{vid}/files/{path}',
    tag: PLUGIN_TAG,
    summary: 'Delete a file of a draft version',
    schema: { params: fileParams, response: z.null() },
    authz: authz.on('catalog.update', entryRes),
    status: 204,
    version: fileVersion,
    handler: async (ctx) => {
      await deleteFile(ctx, ctx.params.id, ctx.params.vid, ctx.params.path);
      return null;
    },
  }),

  // --- plugin sources -------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/plugin-sources',
    tag: PLUGIN_TAG,
    summary: 'List plugin sources',
    schema: { query: listQuerySchema, response: pageOf('PluginSourcePage', pluginSourceRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => pluginSources.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/plugin-sources',
    tag: PLUGIN_TAG,
    summary: 'Add a plugin source (git repository)',
    schema: { body: pluginSourceCreateSchema, response: asRow(pluginSourceRow) },
    authz: authz.on('plugin-sources.write', org),
    handler: (ctx) => pluginSources.create(ctx, { ...ctx.body, lastCommit: null, lastSync: null }),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/plugin-sources/{id}',
    tag: PLUGIN_TAG,
    summary: 'Update a plugin source',
    schema: { params: idParams, body: pluginSourcePatchSchema, response: asRow(pluginSourceRow) },
    authz: authz.on('plugin-sources.write', org),
    version: versionOf('plugin_sources'),
    handler: (ctx) => pluginSources.update(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/plugin-sources/{id}',
    tag: PLUGIN_TAG,
    summary: 'Delete a plugin source',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('plugin-sources.write', org),
    status: 204,
    version: versionOf('plugin_sources'),
    handler: async (ctx) => {
      await pluginSources.remove(ctx, ctx.params.id);
      return null;
    },
  }),
  defineMutation({
    method: 'POST',
    url: '/plugin-sources/{id}/sync',
    tag: PLUGIN_TAG,
    summary: 'Sync a plugin source now',
    schema: { params: idParams, response: asRow(pluginSourceRow) },
    authz: authz.on('plugin-sources.write', org),
    status: 200,
    handler: (ctx) => syncPluginSource(ctx, ctx.params.id),
  }),

  // --- store ----------------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/store',
    tag: 'Store',
    summary: 'Published entries the caller may install',
    schema: { query: storeListQuery, response: untyped(pageOf('StoreEntryPage', storeEntry)) },
    authz: authz.filter('catalog.read'),
    handler: (ctx) => listStore(ctx, ctx.query),
  }),
  defineRoute({
    method: 'GET',
    url: '/store/{slug}',
    tag: 'Store',
    summary: 'One store entry with its current version',
    schema: { params: slugParams, response: untyped(storeEntryDetail) },
    authz: authz.filter('catalog.read'),
    handler: (ctx) => getStoreEntry(ctx, ctx.params.slug),
  }),
];

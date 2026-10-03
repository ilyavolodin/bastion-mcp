import { z } from 'zod';
import {
  authz,
  defineDelete,
  defineMutation,
  defineRoute,
  defineStream,
  type RouteDefinition,
} from '../framework/route';
import { idParams, type OverrideKind, okSchema } from '../schemas/common';
import {
  connectBodySchema,
  connectResultSchema,
  definitionsSchema,
  egressQuery,
  installationCreateSchema,
  installationListQuery,
  installationPatchSchema,
  logsQuery,
  secretMetaSchema,
  secretNameParams,
  secretPutSchema,
  tryBodySchema,
  tryResultSchema,
} from '../schemas/installations';
import { asRow, egressEntry, installationRow, pageOf } from '../schemas/rows';
import {
  beginConnect,
  createInstallation,
  disconnect,
  finalDefinitions,
  installations,
  listInstallations,
  putInstallationSecret,
  requireInstallation,
  restartInstallation,
  updateInstallation,
} from '../services/installations';
import {
  loadCatalogEntryResource,
  orgResource,
  orMissing,
  teamResource,
} from '../services/resources';
import { onInstallation } from './installation-authz';
import { versionOf } from './shared';

const INSTALLATIONS = 'Installations';

const createHint = z
  .object({
    ownerType: z.enum(['user', 'team']).optional(),
    teamId: z.string().optional(),
    catalogEntryId: z.string().optional(),
  })
  .catch({});

/** POST /installations: team installs need the team, catalog installs need the entry, else personal (Org). */
const createAuthz = authz.oneOf(
  ['installations.personal', 'installations.from-entry', 'installations.team'],
  async ({ deps, body }) => {
    const hint = createHint.parse(body ?? {});
    if (hint.ownerType === 'team') {
      return {
        rule: 'installations.team',
        resource: hint.teamId ? teamResource(hint.teamId) : orgResource(),
      };
    }
    if (hint.catalogEntryId) {
      return {
        rule: 'installations.from-entry',
        resource: orMissing(await loadCatalogEntryResource(deps, hint.catalogEntryId)),
      };
    }
    return { rule: 'installations.personal', resource: orgResource() };
  },
);

const definitionRoute = (path: string, kind: OverrideKind, what: string) =>
  defineRoute({
    method: 'GET',
    url: `/installations/{id}/${path}`,
    tag: INSTALLATIONS,
    summary: `Final ${what} of an installation after overrides`,
    schema: { params: idParams, response: definitionsSchema },
    authz: onInstallation('installations.manage'),
    handler: (ctx) => finalDefinitions(ctx, ctx.params.id, kind),
  });

export const installationsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/installations',
    tag: INSTALLATIONS,
    summary: 'List the installations you may manage',
    schema: { query: installationListQuery, response: pageOf('InstallationPage', installationRow) },
    authz: authz.personal(),
    handler: (ctx) => listInstallations(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/installations',
    tag: INSTALLATIONS,
    summary: 'Install a catalog entry (for you or a team) or a personal server',
    schema: { body: installationCreateSchema, response: asRow(installationRow) },
    authz: createAuthz,
    handler: (ctx) => createInstallation(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/installations/{id}',
    tag: INSTALLATIONS,
    summary: 'Get an installation',
    schema: { params: idParams, response: asRow(installationRow) },
    authz: onInstallation('installations.manage'),
    handler: async (ctx) => requireInstallation(ctx.deps, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/installations/{id}',
    tag: INSTALLATIONS,
    summary: 'Update an installation',
    schema: { params: idParams, body: installationPatchSchema, response: asRow(installationRow) },
    authz: onInstallation('installations.manage'),
    version: versionOf('installations'),
    handler: (ctx) => updateInstallation(ctx, ctx.params.id, ctx.body),
  }),
  defineDelete({
    url: '/installations/{id}',
    tag: INSTALLATIONS,
    summary: 'Remove an installation',
    params: idParams,
    authz: onInstallation('installations.manage'),
    version: versionOf('installations'),
    remove: (ctx) => installations.remove(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'POST',
    url: '/installations/{id}/restart',
    tag: INSTALLATIONS,
    summary: 'Restart the installation instances',
    schema: { params: idParams, response: okSchema },
    authz: onInstallation('installations.manage'),
    status: 200,
    handler: (ctx) => restartInstallation(ctx, ctx.params.id),
  }),
  definitionRoute('tools', 'tool', 'tools'),
  definitionRoute('prompts', 'prompt', 'prompts'),
  definitionRoute('resources', 'resource', 'resources'),
  definitionRoute('templates', 'resourceTemplate', 'resource templates'),
  defineRoute({
    method: 'POST',
    url: '/installations/{id}/try',
    tag: INSTALLATIONS,
    summary: 'Call a tool, get a prompt or read a resource through the full pipeline',
    schema: { params: idParams, body: tryBodySchema, response: tryResultSchema },
    authz: onInstallation('installations.manage'),
    readOnly: true,
    handler: async (ctx) => {
      await requireInstallation(ctx.deps, ctx.params.id);
      return ctx.deps.installations.tryCall.run({
        installationId: ctx.params.id,
        principalId: ctx.principal.id,
        request: ctx.body,
        signal: ctx.signal,
      });
    },
  }),
  defineStream({
    url: '/installations/{id}/logs',
    tag: INSTALLATIONS,
    summary: 'Stderr tail of the installation (Server-Sent Events)',
    schema: { params: idParams, query: logsQuery },
    authz: onInstallation('installations.manage'),
    handler: async (ctx) => {
      const id = ctx.params.id;
      await requireInstallation(ctx.deps, id);
      const lines = await ctx.deps.installations.runtime.logTail(id, ctx.query.tail);
      return {
        initial: lines.map((line) => ({ event: 'log', data: { line } })),
        subscribe: (emit, end) => {
          if (!ctx.query.follow) {
            end();
            return () => {};
          }
          return ctx.deps.events.subscribe((event) => {
            if (event.type === 'installation.log' && event.topic === id) {
              emit({ event: 'log', data: event.data, id: event.id });
            }
          });
        },
      };
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/installations/{id}/egress',
    tag: INSTALLATIONS,
    summary: 'Recent egress decisions of the installation',
    schema: {
      params: idParams,
      query: egressQuery,
      response: z.object({ items: z.array(egressEntry), nextCursor: z.null() }),
    },
    authz: onInstallation('installations.manage'),
    handler: async (ctx) => {
      await requireInstallation(ctx.deps, ctx.params.id);
      return {
        items: await ctx.deps.installations.runtime.egress(ctx.params.id, ctx.query.limit),
        nextCursor: null,
      };
    },
  }),
  defineMutation({
    method: 'POST',
    url: '/installations/{id}/connect',
    tag: INSTALLATIONS,
    summary: 'Start the upstream OAuth flow; returns the authorization URL',
    schema: { params: idParams, body: connectBodySchema, response: connectResultSchema },
    authz: onInstallation('installations.manage'),
    status: 200,
    handler: (ctx) => beginConnect(ctx, ctx.params.id, ctx.body.returnTo),
  }),
  defineDelete({
    url: '/installations/{id}/connection',
    tag: INSTALLATIONS,
    summary: 'Disconnect the upstream account',
    params: idParams,
    authz: onInstallation('installations.manage'),
    version: versionOf('installations'),
    remove: (ctx) => disconnect(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/installations/{id}/secrets/{name}',
    tag: INSTALLATIONS,
    summary: 'Set a secret of the installation; the value is never returned',
    schema: { params: secretNameParams, body: secretPutSchema, response: secretMetaSchema },
    authz: onInstallation('installations.manage'),
    status: 200,
    version: versionOf('installations'),
    handler: async (ctx) => {
      const meta = await putInstallationSecret(ctx, ctx.params.id, ctx.params.name, ctx.body.value);
      return {
        name: ctx.params.name,
        scope: meta.scope,
        version: meta.version,
        updatedAt: meta.updatedAt,
      };
    },
  }),
];

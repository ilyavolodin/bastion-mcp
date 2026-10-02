import type { ResourceData } from '@bastion-mcp/policy';
import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import {
  authz,
  defineMutation,
  defineRoute,
  defineStream,
  type RouteDefinition,
  RouteReply,
} from '../framework/route';
import { idParams, okSchema } from '../schemas/common';
import {
  autoInstallCreateSchema,
  autoInstallPatchSchema,
  autoInstallPreviewBody,
  autoInstallPreviewSchema,
  catalogVersionParams,
  clientConfigQuery,
  clientConfigSchema,
  connectBodySchema,
  connectResultSchema,
  definitionsSchema,
  driftApproveSchema,
  driftListQuery,
  driftRejectSchema,
  egressQuery,
  endpointCreateSchema,
  endpointPatchSchema,
  installationCreateSchema,
  installationListQuery,
  installationPatchSchema,
  logsQuery,
  overridesDocSchema,
  overridesViewSchema,
  previewBodySchema,
  previewResultSchema,
  secretMetaSchema,
  secretNameParams,
  secretPutSchema,
  tryBodySchema,
  tryResultSchema,
} from '../schemas/installations';
import {
  asRow,
  autoInstallPolicyRow,
  driftReviewRow,
  egressEntry,
  endpointRow,
  installationRow,
  pageOf,
} from '../schemas/rows';
import {
  autoInstallPolicies,
  createPolicy,
  previewPolicy,
  storedTarget,
  targetResource,
  updatePolicy,
} from '../services/auto-install';
import { clientConfigFor } from '../services/client-config';
import { approveReview, driftReviews, rejectReview } from '../services/drift';
import {
  createEndpoint,
  deleteEndpoint,
  endpointClientConfig,
  getEndpoint,
  listEndpoints,
  ownEndpointVersion,
  updateEndpoint,
} from '../services/endpoints';
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
  catalogOverridesVersion,
  getCatalogOverrides,
  getInstallationOverrides,
  preview,
  putCatalogOverrides,
  putInstallationOverrides,
} from '../services/overrides';
import {
  loadCatalogEntryResource,
  loadInstallationResource,
  orgResource,
  orMissing,
  teamResource,
} from '../services/resources';
import { org, versionOf } from './shared';

const INSTALLATIONS = 'Installations';
const ENDPOINTS = 'Endpoints';
const OVERRIDES = 'Overrides';
const DRIFT = 'Drift';
const AUTO = 'Auto-install';

/** A stand-in with no owner: only admins pass, so a missing row looks the same as a forbidden one. */
const unownedInstallation = (id: string): ResourceData => ({
  type: 'Installation',
  id,
  catalogEntryId: id,
});
const unownedEntry = (id: string): ResourceData => ({ type: 'CatalogEntry', id, risk: 'low' });

/** Authorizes against the addressed installation (a missing row cannot be told from a forbidden one). */
const onInstallation = (rule: string) =>
  authz.on(
    rule,
    async ({ deps, params }) =>
      (await loadInstallationResource(deps, params.id ?? '')) ??
      unownedInstallation(params.id ?? ''),
  );

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

const hintTarget = z
  .object({
    target: z
      .object({
        all: z.boolean().optional(),
        teamIds: z.array(z.string()).optional(),
        roles: z.array(z.string()).optional(),
        idpGroups: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .catch({});

const AUTO_RULES = ['auto-install.team', 'auto-install.org'] as const;

const policyTargetAuthz = authz.oneOf(AUTO_RULES, async ({ body }) => {
  const target = hintTarget.parse(body ?? {}).target;
  return target ? targetResource(target as never) : targetResource({ all: true });
});

const storedPolicyAuthz = authz.oneOf(AUTO_RULES, async ({ deps, params }) => {
  const row = await deps.store.get('auto_install_policies', params.id ?? '');
  const target = storedTarget(row);
  return target ? targetResource(target) : targetResource({ all: true });
});

const definitionRoute = (
  path: string,
  kind: 'tool' | 'prompt' | 'resource' | 'resourceTemplate',
  what: string,
) =>
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
  // --- installations ----------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/installations',
    tag: INSTALLATIONS,
    summary: 'List the installations you may manage',
    schema: { query: installationListQuery, response: pageOf('InstallationPage', installationRow) },
    authz: authz.on('installations.personal', org),
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
  defineMutation({
    method: 'DELETE',
    url: '/installations/{id}',
    tag: INSTALLATIONS,
    summary: 'Remove an installation',
    schema: { params: idParams, response: z.null() },
    authz: onInstallation('installations.manage'),
    status: 204,
    version: versionOf('installations'),
    handler: async (ctx) => {
      await installations.remove(ctx, ctx.params.id);
      return null;
    },
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
  defineMutation({
    method: 'DELETE',
    url: '/installations/{id}/connection',
    tag: INSTALLATIONS,
    summary: 'Disconnect the upstream account',
    schema: { params: idParams, response: z.null() },
    authz: onInstallation('installations.manage'),
    status: 204,
    version: versionOf('installations'),
    handler: async (ctx) => {
      await disconnect(ctx, ctx.params.id);
      return null;
    },
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

  // --- endpoints ---------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/endpoints',
    tag: ENDPOINTS,
    summary: 'List your endpoints',
    schema: { query: listQuerySchema, response: pageOf('EndpointPage', endpointRow) },
    authz: authz.on('installations.personal', org),
    handler: (ctx) => listEndpoints(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/endpoints',
    tag: ENDPOINTS,
    summary: 'Create an endpoint',
    schema: { body: endpointCreateSchema, response: asRow(endpointRow) },
    authz: authz.on('installations.personal', org),
    handler: (ctx) => createEndpoint(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Get an endpoint',
    schema: { params: idParams, response: asRow(endpointRow) },
    authz: authz.on('installations.personal', org),
    handler: (ctx) => getEndpoint(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Update an endpoint',
    schema: { params: idParams, body: endpointPatchSchema, response: asRow(endpointRow) },
    authz: authz.on('installations.personal', org),
    version: (input) => ownEndpointVersion(input.deps, input.principal.id, input.params.id ?? ''),
    handler: (ctx) => updateEndpoint(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Delete an endpoint',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('installations.personal', org),
    status: 204,
    version: (input) => ownEndpointVersion(input.deps, input.principal.id, input.params.id ?? ''),
    handler: async (ctx) => {
      await deleteEndpoint(ctx, ctx.params.id);
      return null;
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/endpoints/{id}/client-config',
    tag: ENDPOINTS,
    summary: 'Configuration to paste into an MCP client',
    schema: { params: idParams, query: clientConfigQuery, response: clientConfigSchema },
    authz: authz.on('installations.personal', org),
    handler: (ctx) => endpointClientConfig(ctx, ctx.params.id, ctx.query.client, ctx.query.auth),
  }),
  defineRoute({
    method: 'GET',
    url: '/client-config',
    tag: ENDPOINTS,
    summary: 'Configuration to paste into an MCP client for the default endpoint (/mcp)',
    schema: { query: clientConfigQuery, response: clientConfigSchema },
    authz: authz.on('installations.personal', org),
    handler: (ctx) =>
      clientConfigFor(
        ctx.query.client,
        { baseUrl: ctx.deps.config.baseUrl, slug: null },
        ctx.query.auth,
      ),
  }),

  // --- overrides ---------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/catalog/{id}/versions/{vid}/overrides',
    tag: OVERRIDES,
    summary: 'Catalog-layer overrides of a version',
    schema: { params: catalogVersionParams, response: overridesViewSchema },
    authz: authz.on(
      'overrides.catalog',
      async ({ deps, params }) =>
        (await loadCatalogEntryResource(deps, params.id ?? '')) ?? unownedEntry(params.id ?? ''),
    ),
    handler: (ctx) => getCatalogOverrides(ctx, ctx.params.id, ctx.params.vid),
  }),
  defineMutation({
    method: 'PUT',
    url: '/catalog/{id}/versions/{vid}/overrides',
    tag: OVERRIDES,
    summary: 'Replace the catalog-layer overrides of a draft version',
    schema: {
      params: catalogVersionParams,
      body: overridesDocSchema,
      response: overridesViewSchema,
    },
    authz: authz.on(
      'overrides.catalog',
      async ({ deps, params }) =>
        (await loadCatalogEntryResource(deps, params.id ?? '')) ?? unownedEntry(params.id ?? ''),
    ),
    status: 200,
    version: (input) =>
      catalogOverridesVersion(input.deps, input.params.id ?? '', input.params.vid ?? ''),
    handler: (ctx) => putCatalogOverrides(ctx, ctx.params.id, ctx.params.vid, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/installations/{id}/overrides',
    tag: OVERRIDES,
    summary: 'Installation-layer overrides',
    schema: { params: idParams, response: overridesViewSchema },
    authz: onInstallation('overrides.installation'),
    handler: (ctx) => getInstallationOverrides(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/installations/{id}/overrides',
    tag: OVERRIDES,
    summary: 'Replace the installation-layer overrides, bounded by userOverrides',
    schema: { params: idParams, body: overridesDocSchema, response: overridesViewSchema },
    authz: onInstallation('overrides.installation'),
    status: 200,
    version: versionOf('installations'),
    handler: (ctx) => putInstallationOverrides(ctx, ctx.params.id, ctx.body),
  }),
  defineRoute({
    method: 'POST',
    url: '/overrides/preview',
    tag: OVERRIDES,
    summary: 'Final definitions and diff for an unsaved overrides document',
    schema: { body: previewBodySchema, response: previewResultSchema },
    authz: authz.on('installations.personal', org),
    readOnly: true,
    handler: async (ctx) => new RouteReply(await preview(ctx, ctx.body)),
  }),

  // --- drift -------------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/drift-reviews',
    tag: DRIFT,
    summary: 'Definition drift reviews',
    schema: { query: driftListQuery, response: pageOf('DriftReviewPage', driftReviewRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) =>
      driftReviews.list(ctx, ctx.query, {
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(ctx.query.installationId ? { installationId: ctx.query.installationId } : {}),
        ...(ctx.query.catalogVersionId ? { catalogVersionId: ctx.query.catalogVersionId } : {}),
      }),
  }),
  defineMutation({
    method: 'POST',
    url: '/drift-reviews/{id}/approve',
    tag: DRIFT,
    summary: 'Approve a changed definition',
    schema: { params: idParams, body: driftApproveSchema, response: asRow(driftReviewRow) },
    authz: authz.on('drift.write', org),
    status: 200,
    handler: (ctx) => approveReview(ctx, ctx.params.id, ctx.body.note),
  }),
  defineMutation({
    method: 'POST',
    url: '/drift-reviews/{id}/reject',
    tag: DRIFT,
    summary: 'Reject a changed definition',
    schema: { params: idParams, body: driftRejectSchema, response: asRow(driftReviewRow) },
    authz: authz.on('drift.write', org),
    status: 200,
    handler: (ctx) => rejectReview(ctx, ctx.params.id, ctx.body.reason),
  }),

  // --- auto-install ------------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/auto-install-policies',
    tag: AUTO,
    summary: 'Auto-install policies',
    schema: {
      query: listQuerySchema,
      response: pageOf('AutoInstallPolicyPage', autoInstallPolicyRow),
    },
    authz: authz.on('org.view', org),
    handler: (ctx) => autoInstallPolicies.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/auto-install-policies',
    tag: AUTO,
    summary: 'Create an auto-install policy',
    schema: { body: autoInstallCreateSchema, response: asRow(autoInstallPolicyRow) },
    authz: policyTargetAuthz,
    handler: (ctx) => createPolicy(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/auto-install-policies/{id}',
    tag: AUTO,
    summary: 'Update an auto-install policy',
    schema: {
      params: idParams,
      body: autoInstallPatchSchema,
      response: asRow(autoInstallPolicyRow),
    },
    authz: storedPolicyAuthz,
    version: versionOf('auto_install_policies'),
    handler: (ctx) => updatePolicy(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/auto-install-policies/{id}',
    tag: AUTO,
    summary: 'Delete an auto-install policy',
    schema: { params: idParams, response: z.null() },
    authz: storedPolicyAuthz,
    status: 204,
    version: versionOf('auto_install_policies'),
    handler: async (ctx) => {
      await autoInstallPolicies.remove(ctx, ctx.params.id);
      return null;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/auto-install-policies/{id}/preview',
    tag: AUTO,
    summary: 'Who would get what, with counts',
    schema: { params: idParams, body: autoInstallPreviewBody, response: autoInstallPreviewSchema },
    authz: storedPolicyAuthz,
    readOnly: true,
    handler: (ctx) => {
      const { target, mode, scope, applyToExisting } = ctx.body;
      return previewPolicy(ctx, ctx.params.id, {
        ...(target ? { target } : {}),
        ...(mode ? { mode } : {}),
        ...(scope ? { scope } : {}),
        ...(applyToExisting === undefined ? {} : { applyToExisting }),
      });
    },
  }),
];

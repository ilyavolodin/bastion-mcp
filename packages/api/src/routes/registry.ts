import type { ResourceData } from '@bastion-mcp/policy';
import { z } from 'zod';
import { listQuerySchema, pageSchema } from '../framework/conventions';
import {
  authz,
  defineMutation,
  defineRoute,
  type RouteDefinition,
  RouteReply,
} from '../framework/route';
import { idParams } from '../schemas/common';
import {
  installBodySchema,
  installResultSchema,
  registryPolicyBodySchema,
  registryPolicyView,
  registryServerDetail,
  registryServerSummary,
  registrySourceCreateSchema,
  registrySourcePatchSchema,
  requestCreateSchema,
  requestListQuery,
  requestRejectSchema,
  serverParams,
  serverSearchQuery,
  syncBodySchema,
  syncResultSchema,
} from '../schemas/registry';
import { asRow, installRequestRow, pageOf, registrySourceRow } from '../schemas/rows';
import {
  approveInstallRequest,
  createSource,
  deleteSource,
  getPolicy,
  installFromRegistry,
  listRequests,
  policyVersion,
  putPolicy,
  registrySources,
  rejectInstallRequest,
  searchServers,
  serverDetail,
  submitRequest,
  syncNow,
  updateSource,
} from '../services/registry';
import { loadUserResource } from '../services/resources';
import { org, versionOf } from './shared';

const TAG = 'Registry';

/** A user that does not exist: everyone but admins is denied, so a missing id leaks nothing. */
const MISSING_USER: ResourceData = {
  type: 'User',
  id: 'missing',
  role: 'member',
  active: true,
  emailDomain: '',
  teamIds: [],
  managedTeamIds: [],
};

const requesterOf = async (input: {
  deps: Parameters<typeof loadUserResource>[0];
  params: Record<string, string>;
}): Promise<ResourceData> => {
  const request = await input.deps.store.get('install_requests', input.params.id ?? '');
  const requesterId = typeof request?.requesterId === 'string' ? request.requesterId : null;
  return (requesterId ? await loadUserResource(input.deps, requesterId) : null) ?? MISSING_USER;
};

export const registryRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/registry-sources',
    tag: TAG,
    summary: 'List registry sources',
    schema: { query: listQuerySchema, response: pageOf('RegistrySourcePage', registrySourceRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => registrySources.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/registry-sources',
    tag: TAG,
    summary: 'Add a registry source',
    schema: { body: registrySourceCreateSchema, response: asRow(registrySourceRow) },
    authz: authz.on('registry.sources.write', org),
    handler: (ctx) => createSource(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/registry-sources/{id}',
    tag: TAG,
    summary: 'Update a registry source',
    schema: {
      params: idParams,
      body: registrySourcePatchSchema,
      response: asRow(registrySourceRow),
    },
    authz: authz.on('registry.sources.write', org),
    version: versionOf('registry_sources'),
    handler: (ctx) => updateSource(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/registry-sources/{id}',
    tag: TAG,
    summary: 'Remove a registry source and its policy',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('registry.sources.write', org),
    status: 204,
    version: versionOf('registry_sources'),
    handler: async (ctx) => {
      await deleteSource(ctx, ctx.params.id);
      return null;
    },
  }),
  defineMutation({
    method: 'POST',
    url: '/registry-sources/{id}/sync',
    tag: TAG,
    summary: 'Sync a registry source now',
    schema: {
      params: idParams,
      body: syncBodySchema.default({ full: false }),
      response: syncResultSchema,
    },
    authz: authz.on('registry.sources.write', org),
    status: 200,
    handler: (ctx) => syncNow(ctx, ctx.params.id, ctx.body.full),
  }),
  defineRoute({
    method: 'GET',
    url: '/registry-sources/{id}/policy',
    tag: TAG,
    summary: 'The one-click install policy of a source',
    schema: { params: idParams, response: registryPolicyView },
    authz: authz.on('org.view', org),
    handler: (ctx) => getPolicy(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/registry-sources/{id}/policy',
    tag: TAG,
    summary: 'Replace the install policy of a source',
    schema: { params: idParams, body: registryPolicyBodySchema, response: registryPolicyView },
    authz: authz.on('registry.sources.write', org),
    status: 200,
    version: (input) => policyVersion(input, input.params.id ?? ''),
    handler: (ctx) => putPolicy(ctx, ctx.params.id, ctx.body),
  }),

  defineRoute({
    method: 'GET',
    url: '/registry/servers',
    tag: TAG,
    summary: 'Browse the mirrored registry servers',
    schema: {
      query: serverSearchQuery,
      response: pageSchema(registryServerSummary).meta({ id: 'RegistryServerPage' }),
    },
    authz: authz.on('registry.install', org),
    handler: (ctx) => searchServers(ctx, ctx.query),
  }),
  defineRoute({
    method: 'GET',
    url: '/registry/servers/{sourceId}/{name}/{version}',
    tag: TAG,
    summary: 'One registry server with the install decision for the caller',
    schema: { params: serverParams, response: registryServerDetail },
    authz: authz.on('registry.install', org),
    handler: (ctx) => serverDetail(ctx, ctx.params.sourceId, ctx.params.name, ctx.params.version),
  }),
  defineMutation({
    method: 'POST',
    url: '/registry/install',
    tag: TAG,
    summary: 'Install a registry server according to the source policy',
    schema: { body: installBodySchema, response: installResultSchema },
    authz: authz.on('registry.install', org),
    status: 201,
    handler: async (ctx) => {
      const out = await installFromRegistry(ctx, ctx.body);
      return out.decision === 'needs-request' ? new RouteReply(out, { status: 202 }) : out;
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/install-requests',
    tag: TAG,
    summary: 'Install requests you may see',
    schema: { query: requestListQuery, response: pageOf('InstallRequestPage', installRequestRow) },
    authz: authz.on('registry.install', org),
    handler: (ctx) => listRequests(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/install-requests',
    tag: TAG,
    summary: 'Request installation of a registry server',
    schema: { body: requestCreateSchema, response: asRow(installRequestRow) },
    authz: authz.on('registry.install', org),
    handler: (ctx) => submitRequest(ctx, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/install-requests/{id}/approve',
    tag: TAG,
    summary: 'Approve a request and install for the requester',
    schema: { params: idParams, response: asRow(installRequestRow) },
    authz: authz.on('registry.requests.decide', requesterOf),
    status: 200,
    handler: (ctx) => approveInstallRequest(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'POST',
    url: '/install-requests/{id}/reject',
    tag: TAG,
    summary: 'Reject a request with a reason',
    schema: { params: idParams, body: requestRejectSchema, response: asRow(installRequestRow) },
    authz: authz.on('registry.requests.decide', requesterOf),
    status: 200,
    handler: (ctx) => rejectInstallRequest(ctx, ctx.params.id, ctx.body.reason),
  }),
];

import { listQuerySchema } from '../framework/conventions';
import {
  authz,
  defineDelete,
  defineMutation,
  defineRoute,
  type RouteDefinition,
} from '../framework/route';
import { idParams } from '../schemas/common';
import {
  clientConfigQuery,
  clientConfigSchema,
  endpointCreateSchema,
  endpointPatchSchema,
} from '../schemas/installations';
import { asRow, endpointRow, pageOf } from '../schemas/rows';
import { clientConfigFor } from '../services/client-config';
import {
  createEndpoint,
  deleteEndpoint,
  endpointClientConfig,
  getEndpoint,
  listEndpoints,
  ownEndpointVersion,
  updateEndpoint,
} from '../services/endpoints';

const ENDPOINTS = 'Endpoints';

export const endpointsRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/endpoints',
    tag: ENDPOINTS,
    summary: 'List your endpoints',
    schema: { query: listQuerySchema, response: pageOf('EndpointPage', endpointRow) },
    authz: authz.personal(),
    handler: (ctx) => listEndpoints(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/endpoints',
    tag: ENDPOINTS,
    summary: 'Create an endpoint',
    schema: { body: endpointCreateSchema, response: asRow(endpointRow) },
    authz: authz.personal(),
    handler: (ctx) => createEndpoint(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Get an endpoint',
    schema: { params: idParams, response: asRow(endpointRow) },
    authz: authz.personal(),
    handler: (ctx) => getEndpoint(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Update an endpoint',
    schema: { params: idParams, body: endpointPatchSchema, response: asRow(endpointRow) },
    authz: authz.personal(),
    version: (input) => ownEndpointVersion(input.deps, input.principal.id, input.params.id ?? ''),
    handler: (ctx) => updateEndpoint(ctx, ctx.params.id, ctx.body),
  }),
  defineDelete({
    url: '/endpoints/{id}',
    tag: ENDPOINTS,
    summary: 'Delete an endpoint',
    params: idParams,
    authz: authz.personal(),
    version: (input) => ownEndpointVersion(input.deps, input.principal.id, input.params.id ?? ''),
    remove: (ctx) => deleteEndpoint(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/endpoints/{id}/client-config',
    tag: ENDPOINTS,
    summary: 'Configuration to paste into an MCP client',
    schema: { params: idParams, query: clientConfigQuery, response: clientConfigSchema },
    authz: authz.personal(),
    handler: (ctx) => endpointClientConfig(ctx, ctx.params.id, ctx.query.client, ctx.query.auth),
  }),
  defineRoute({
    method: 'GET',
    url: '/client-config',
    tag: ENDPOINTS,
    summary: 'Configuration to paste into an MCP client for the default endpoint (/mcp)',
    schema: { query: clientConfigQuery, response: clientConfigSchema },
    authz: authz.personal(),
    handler: (ctx) =>
      clientConfigFor(
        ctx.query.client,
        { baseUrl: ctx.deps.config.baseUrl, slug: null },
        ctx.query.auth,
      ),
  }),
];

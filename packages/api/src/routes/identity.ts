import { z } from 'zod';
import { listQuerySchema } from '../framework/conventions';
import {
  type AuthzInput,
  authz,
  defineMutation,
  defineRoute,
  type RouteDefinition,
} from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  credentialsBodySchema,
  credentialsResponseSchema,
  idpCreateSchema,
  idpPatchSchema,
  idpTestResponseSchema,
  oauthClientCreateSchema,
  oauthClientPatchSchema,
  scimTokenCreatedSchema,
  scimTokenCreateSchema,
  serviceAccountCreateSchema,
  serviceAccountListQuery,
  serviceAccountPatchSchema,
} from '../schemas/identity';
import {
  asRow,
  idpConnectionRow,
  oauthClientRow,
  pageOf,
  scimTokenCreatedRow,
  scimTokenRow,
  serviceAccountCreatedRow,
  serviceAccountRow,
} from '../schemas/rows';
import {
  createIdp,
  createScimToken,
  createServiceAccount,
  deleteIdp,
  deleteServiceAccount,
  idpConnections,
  oauthClients,
  registerOauthClient,
  revokeScimToken,
  rotateCredentials,
  scimTokens,
  serviceAccounts,
  testIdp,
  updateIdp,
} from '../services/identity';
import { orgResource, teamResource } from '../services/resources';
import { org, versionOf } from './shared';

const SA = 'Service accounts and tokens';
const IDP = 'Identity providers';
const OAUTH = 'OAuth clients';

/** Create: the team named in the body administers the new account (10.1). */
const accountTeamFromBody = (input: AuthzInput) => {
  const teamId = z.object({ teamId: z.string().min(1) }).safeParse(input.body);
  return teamId.success ? teamResource(teamId.data.teamId) : orgResource();
};

/** Everything else: the stored row decides, never the request body. */
const accountTeamOfRow = async (input: AuthzInput) => {
  const row = await input.deps.store.get('service_accounts', input.params.id ?? '');
  return typeof row?.teamId === 'string' ? teamResource(row.teamId) : orgResource();
};

const serviceAccountCreated = itemSchema.extend({
  clientId: z.string(),
  authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
  clientSecret: z.string().optional(),
});

export const identityRoutes: RouteDefinition[] = [
  // --- service accounts -------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/service-accounts',
    tag: SA,
    summary: 'List service accounts',
    schema: {
      query: serviceAccountListQuery,
      response: pageOf('ServiceAccountPage', serviceAccountRow),
    },
    authz: authz.on('org.view', org),
    handler: (ctx) =>
      serviceAccounts.list(
        ctx,
        ctx.query,
        ctx.query.teamId ? { teamId: ctx.query.teamId } : undefined,
      ),
  }),
  defineMutation({
    method: 'POST',
    url: '/service-accounts',
    tag: SA,
    summary: 'Create a service account; the client secret is shown once',
    schema: { body: serviceAccountCreateSchema, response: asRow(serviceAccountCreatedRow) },
    authz: authz.on('service-accounts.write', accountTeamFromBody),
    handler: (ctx) => createServiceAccount(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/service-accounts/{id}',
    tag: SA,
    summary: 'Update a service account',
    schema: {
      params: idParams,
      body: serviceAccountPatchSchema,
      response: asRow(serviceAccountRow),
    },
    authz: authz.on('service-accounts.write', accountTeamOfRow),
    version: versionOf('service_accounts'),
    handler: (ctx) => serviceAccounts.update(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/service-accounts/{id}',
    tag: SA,
    summary: 'Delete a service account and revoke its tokens',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('service-accounts.write', accountTeamOfRow),
    status: 204,
    version: versionOf('service_accounts'),
    handler: async (ctx) => {
      await deleteServiceAccount(ctx, ctx.params.id);
      return null;
    },
  }),
  defineMutation({
    method: 'POST',
    url: '/service-accounts/{id}/credentials',
    tag: SA,
    summary: 'Rotate the client secret or replace the registered public keys',
    schema: { params: idParams, body: credentialsBodySchema, response: credentialsResponseSchema },
    authz: authz.on('service-accounts.write', accountTeamOfRow),
    status: 200,
    handler: (ctx) => rotateCredentials(ctx, ctx.params.id, ctx.body),
  }),

  // --- identity providers -----------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/idp-connections',
    tag: IDP,
    summary: 'List identity provider connections',
    schema: { query: listQuerySchema, response: pageOf('IdpConnectionPage', idpConnectionRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => idpConnections.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/idp-connections',
    tag: IDP,
    summary: 'Create an identity provider connection',
    schema: { body: idpCreateSchema, response: asRow(idpConnectionRow) },
    authz: authz.on('idp.write', org),
    handler: (ctx) => createIdp(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/idp-connections/{id}',
    tag: IDP,
    summary: 'Get an identity provider connection',
    schema: { params: idParams, response: asRow(idpConnectionRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => idpConnections.get(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/idp-connections/{id}',
    tag: IDP,
    summary: 'Update an identity provider connection',
    schema: { params: idParams, body: idpPatchSchema, response: asRow(idpConnectionRow) },
    authz: authz.on('idp.write', org),
    version: versionOf('idp_connections'),
    handler: (ctx) => updateIdp(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/idp-connections/{id}',
    tag: IDP,
    summary: 'Delete an identity provider connection',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('idp.write', org),
    status: 204,
    version: versionOf('idp_connections'),
    handler: async (ctx) => {
      await deleteIdp(ctx, ctx.params.id);
      return null;
    },
  }),
  defineRoute({
    method: 'POST',
    url: '/idp-connections/{id}/test',
    tag: IDP,
    summary: 'Fetch the discovery document and check the issuer',
    schema: { params: idParams, response: idpTestResponseSchema },
    authz: authz.on('idp.write', org),
    readOnly: true,
    handler: (ctx) => testIdp(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/scim-tokens',
    tag: IDP,
    summary: 'List SCIM tokens (metadata only)',
    schema: { query: listQuerySchema, response: pageOf('ScimTokenPage', scimTokenRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => scimTokens.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/scim-tokens',
    tag: IDP,
    summary: 'Create a SCIM token; the secret is shown once',
    schema: { body: scimTokenCreateSchema, response: asRow(scimTokenCreatedRow) },
    authz: authz.on('idp.write', org),
    handler: (ctx) => createScimToken(ctx, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/scim-tokens/{id}',
    tag: IDP,
    summary: 'Revoke a SCIM token',
    schema: { params: idParams, response: z.null() },
    authz: authz.on('idp.write', org),
    status: 204,
    version: versionOf('scim_tokens'),
    handler: async (ctx) => {
      await revokeScimToken(ctx, ctx.params.id);
      return null;
    },
  }),

  // --- OAuth clients ----------------------------------------------------------------------------------
  defineRoute({
    method: 'GET',
    url: '/oauth-clients',
    tag: OAUTH,
    summary: 'OAuth client policies (pre-approved and blocked clients)',
    schema: { query: listQuerySchema, response: pageOf('OAuthClientPolicyPage', oauthClientRow) },
    authz: authz.on('org.view', org),
    handler: (ctx) => oauthClients.list(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/oauth-clients',
    tag: OAUTH,
    summary: 'Pre-register an OAuth client policy',
    schema: { body: oauthClientCreateSchema, response: asRow(oauthClientRow) },
    authz: authz.on('oauth-clients.write', org),
    handler: (ctx) => registerOauthClient(ctx, ctx.body),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/oauth-clients/{id}',
    tag: OAUTH,
    summary: 'Pre-approve or block an OAuth client',
    schema: { params: idParams, body: oauthClientPatchSchema, response: asRow(oauthClientRow) },
    authz: authz.on('oauth-clients.write', org),
    version: versionOf('oauth_clients'),
    handler: (ctx) =>
      oauthClients.update(ctx, ctx.params.id, { ...ctx.body, updatedBy: ctx.principal.id }),
  }),
];

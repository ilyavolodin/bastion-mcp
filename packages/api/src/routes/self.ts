import { PAT_SCOPES } from '@bastion-mcp/auth';
import { z } from 'zod';
import { listQuerySchema, pageSchema } from '../framework/conventions';
import {
  authz,
  defineDelete,
  defineMutation,
  defineRoute,
  type RouteDefinition,
} from '../framework/route';
import { idParams, nameSchema } from '../schemas/common';
import { asRow, notificationRow, oauthGrantRow, pageOf } from '../schemas/rows';
import {
  createToken,
  getMe,
  grantVersion,
  listGrants,
  listNotifications,
  listTokens,
  markNotificationRead,
  meVersion,
  myQuotas,
  revokeGrant,
  revokeToken,
  tokenVersion,
  updateMe,
} from '../services/self';

const TAG = 'Session and self';

const meSchema = z.object({
  id: z.string(),
  type: z.enum(['user', 'service']),
  orgRole: z.string(),
  authMethod: z.string(),
  scopes: z.array(z.string()),
  email: z.string().optional(),
  displayName: z.string(),
  status: z.string(),
  teams: z.array(
    z.object({
      teamId: z.string(),
      role: z.string(),
      slug: z.string().optional(),
      displayName: z.string().optional(),
    }),
  ),
  org: z.object({
    name: z.string(),
    host: z.string(),
    baseUrl: z.string(),
    traceUiUrl: z.string().nullable(),
    toolWarnThreshold: z.number(),
  }),
  capabilities: z.object({
    registry: z.boolean(),
    publishOrgWide: z.boolean(),
    personalInstalls: z.enum(['off', 'remoteOnly', 'all']),
  }),
  updatedAt: z.string(),
});

const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  endpointId: z.string().nullable(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const quotaSchema = z.looseObject({
  ruleId: z.string(),
  name: z.string(),
  kind: z.string(),
  subjectId: z.string(),
  limit: z.number(),
  consumed: z.number(),
  remaining: z.number(),
  resetsAt: z.string().nullable(),
});

export const selfRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/me',
    tag: TAG,
    summary: 'The authenticated caller',
    schema: { response: meSchema },
    authz: authz.self(),
    handler: (ctx) => getMe(ctx),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/me',
    tag: TAG,
    summary: 'Update your profile',
    schema: {
      body: z.object({ displayName: nameSchema.optional() }),
      response: meSchema,
    },
    authz: authz.self(),
    version: (input) => meVersion(input),
    handler: (ctx) => updateMe(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/me/notifications',
    tag: TAG,
    summary: 'Your notifications, newest first',
    schema: {
      query: listQuerySchema.extend({ unread: z.stringbool().optional() }),
      response: pageOf('NotificationPage', notificationRow),
    },
    authz: authz.self(),
    handler: (ctx) => listNotifications(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/me/notifications/{id}/read',
    tag: TAG,
    summary: 'Mark a notification read',
    schema: { params: idParams, response: asRow(notificationRow) },
    authz: authz.self(),
    status: 200,
    handler: (ctx) => markNotificationRead(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/me/quotas',
    tag: TAG,
    summary: 'Current consumption of the limits that apply to you',
    schema: { response: z.object({ items: z.array(quotaSchema) }) },
    authz: authz.self(),
    handler: async (ctx) => ({ items: await myQuotas(ctx) }),
  }),
  defineRoute({
    method: 'GET',
    url: '/me/oauth-grants',
    tag: TAG,
    summary: 'OAuth clients you have granted access',
    schema: { query: listQuerySchema, response: pageOf('OAuthGrantPage', oauthGrantRow) },
    authz: authz.self(),
    handler: (ctx) => listGrants(ctx, ctx.query),
  }),
  defineDelete({
    url: '/me/oauth-grants/{id}',
    tag: TAG,
    summary: 'Revoke an OAuth grant',
    params: idParams,
    authz: authz.self(),
    version: (input) => grantVersion(input, input.params.id ?? ''),
    remove: (ctx) => revokeGrant(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/tokens',
    tag: 'Service accounts and tokens',
    summary: 'Your personal access tokens (metadata only)',
    schema: { response: pageSchema(tokenSchema) },
    authz: authz.self(),
    handler: async (ctx) => ({ items: await listTokens(ctx), nextCursor: null }),
  }),
  defineMutation({
    method: 'POST',
    url: '/tokens',
    tag: 'Service accounts and tokens',
    summary: 'Create a personal access token; the secret is shown once',
    schema: {
      body: z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(PAT_SCOPES)).min(1),
        expiresInDays: z.number().positive().max(3650).optional(),
        endpointId: z.string().min(1).optional(),
      }),
      response: z.object({ token: z.string(), metadata: tokenSchema }),
    },
    authz: authz.self(),
    handler: (ctx) => createToken(ctx, ctx.body),
  }),
  defineDelete({
    url: '/tokens/{id}',
    tag: 'Service accounts and tokens',
    summary: 'Revoke a personal access token',
    params: idParams,
    authz: authz.self(),
    version: (input) => tokenVersion(input, input.params.id ?? ''),
    remove: (ctx) => revokeToken(ctx, ctx.params.id),
  }),
];

import { z } from 'zod';
import { listQuerySchema, pageSchema } from '../framework/conventions';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import { idParams, itemPage, itemSchema } from '../schemas/common';
import {
  itemBodySchema,
  itemParams,
  marketplaceCreateSchema,
  marketplacePatchSchema,
  mirrorBodySchema,
  mirrorViewSchema,
  releaseParams,
  releaseSchema,
  rolloutQuery,
  usageQuery,
} from '../schemas/marketplaces';
import {
  createChoice,
  createMarketplace,
  deleteMarketplace,
  getMirror,
  itemId,
  listMarketplaces,
  listReleases,
  marketplaces,
  promoteRelease,
  pushMirror,
  putItem,
  putMirror,
  readChoice,
  removeItem,
  rollout,
  usage,
  writeChoice,
} from '../services/marketplaces';
import { versionOf } from './shared';

const TAG = 'Marketplaces';
const READ = ['catalog.read'] as const;
const WRITE = ['marketplaces.write.team', 'marketplaces.write.org'] as const;

const itemVersion = async (input: {
  deps: import('../ports').ApiDeps;
  params: Record<string, string>;
}): Promise<string | null> =>
  (
    await input.deps.store.get(
      'marketplace_items',
      itemId(input.params.id ?? '', input.params.entryId ?? ''),
    )
  )?.updatedAt ?? null;

export const marketplacesRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/marketplaces',
    tag: TAG,
    summary: 'List the marketplaces you may see',
    schema: { query: listQuerySchema, response: itemPage },
    authz: authz.filter('catalog.read'),
    handler: (ctx) => listMarketplaces(ctx, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/marketplaces',
    tag: TAG,
    summary: 'Create a marketplace',
    schema: { body: marketplaceCreateSchema, response: itemSchema },
    authz: authz.oneOf(WRITE, createChoice),
    handler: (ctx) => createMarketplace(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/marketplaces/{id}',
    tag: TAG,
    summary: 'Get a marketplace',
    schema: { params: idParams, response: itemSchema },
    authz: authz.oneOf(READ, readChoice),
    handler: (ctx) => marketplaces.get(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/marketplaces/{id}',
    tag: TAG,
    summary: 'Update a marketplace',
    schema: { params: idParams, body: marketplacePatchSchema, response: itemSchema },
    authz: authz.oneOf(WRITE, writeChoice),
    version: versionOf('marketplaces'),
    handler: (ctx) => marketplaces.update(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/marketplaces/{id}',
    tag: TAG,
    summary: 'Delete a marketplace and its items',
    schema: { params: idParams, response: z.null() },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 204,
    version: versionOf('marketplaces'),
    handler: async (ctx) => {
      await deleteMarketplace(ctx, ctx.params.id);
      return null;
    },
  }),
  defineMutation({
    method: 'PUT',
    url: '/marketplaces/{id}/items/{entryId}',
    tag: TAG,
    summary: 'Add an item or change its policy and pin; cuts a release',
    schema: { params: itemParams, body: itemBodySchema, response: itemSchema },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 200,
    version: itemVersion,
    handler: (ctx) => putItem(ctx, ctx.params.id, ctx.params.entryId, ctx.body),
  }),
  defineMutation({
    method: 'DELETE',
    url: '/marketplaces/{id}/items/{entryId}',
    tag: TAG,
    summary: 'Remove an item; cuts a release',
    schema: { params: itemParams, response: z.null() },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 204,
    version: itemVersion,
    handler: async (ctx) => {
      await removeItem(ctx, ctx.params.id, ctx.params.entryId);
      return null;
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/marketplaces/{id}/releases',
    tag: TAG,
    summary: 'Releases, newest first',
    schema: { params: idParams, query: listQuerySchema, response: pageSchema(releaseSchema) },
    authz: authz.oneOf(READ, readChoice),
    handler: (ctx) => listReleases(ctx, ctx.params.id, ctx.query),
  }),
  defineMutation({
    method: 'POST',
    url: '/marketplaces/{id}/releases/{n}/promote',
    tag: TAG,
    summary: 'Promote a release: pinned client configurations reference it',
    schema: { params: releaseParams, response: releaseSchema },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 200,
    handler: (ctx) => promoteRelease(ctx, ctx.params.id, ctx.params.n),
  }),
  defineRoute({
    method: 'GET',
    url: '/marketplaces/{id}/mirror',
    tag: TAG,
    summary: 'Mirror target and status',
    schema: { params: idParams, response: mirrorViewSchema },
    authz: authz.oneOf(READ, readChoice),
    handler: (ctx) => getMirror(ctx, ctx.params.id),
  }),
  defineMutation({
    method: 'PUT',
    url: '/marketplaces/{id}/mirror',
    tag: TAG,
    summary: 'Set the mirror target',
    schema: { params: idParams, body: mirrorBodySchema, response: mirrorViewSchema },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 200,
    version: versionOf('marketplaces'),
    handler: (ctx) => putMirror(ctx, ctx.params.id, ctx.body),
  }),
  defineMutation({
    method: 'POST',
    url: '/marketplaces/{id}/mirror/push',
    tag: TAG,
    summary: 'Push the latest release to the mirror now',
    schema: { params: idParams, response: z.looseObject({ status: z.string() }) },
    authz: authz.oneOf(WRITE, writeChoice),
    status: 200,
    handler: (ctx) => pushMirror(ctx, ctx.params.id),
  }),
  defineRoute({
    method: 'GET',
    url: '/marketplaces/{id}/rollout',
    tag: TAG,
    summary: 'Copy-ready client configuration (25.7)',
    schema: {
      params: idParams,
      query: rolloutQuery,
      response: z.looseObject({ client: z.string() }),
    },
    authz: authz.oneOf(READ, readChoice),
    handler: (ctx) => rollout(ctx, ctx.params.id, ctx.query.client),
  }),
  defineRoute({
    method: 'GET',
    url: '/marketplaces/{id}/usage',
    tag: TAG,
    summary: 'Distribution usage (25.9)',
    schema: {
      params: idParams,
      query: usageQuery,
      response: z.object({
        buckets: z.array(
          z.object({ ts: z.string(), channel: z.string(), action: z.string(), count: z.number() }),
        ),
      }),
    },
    authz: authz.oneOf(READ, readChoice),
    handler: (ctx) => usage(ctx, ctx.params.id, ctx.query),
  }),
];

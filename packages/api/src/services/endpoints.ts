import { isValidSlug } from '@bastion-mcp/core';
import { ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import type { ApiDeps } from '../ports';
import type { Page, Row } from '../ports/store';
import { type ClientAuth, type ClientKind, clientConfigFor } from './client-config';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';
import { loadInstallationResource } from './resources';

export const endpoints = new CrudService({
  collection: 'endpoints',
  targetType: 'endpoint',
  action: 'endpoint',
  configTopic: 'endpoints',
});

/** Endpoints are the caller's own (17.2): other people's endpoints do not exist for them. */
const requireOwn = async (
  store: ApiDeps['store'],
  principalId: string,
  id: string,
): Promise<Row> => {
  const row = await store.get('endpoints', id);
  if (!row || row.ownerId !== principalId) throw new NotFoundApiError('endpoint');
  return row;
};

export const ownEndpointVersion = async (
  deps: ApiDeps,
  principalId: string,
  id: string,
): Promise<string | null> => {
  const row = await deps.store.get('endpoints', id);
  return row && row.ownerId === principalId ? row.updatedAt : null;
};

export const listEndpoints = (
  ctx: ReadCtx,
  query: {
    limit: number;
    cursor?: string | undefined;
    q?: string | undefined;
    sort?: string | undefined;
  },
): Promise<Page<Row>> =>
  endpoints.list(ctx, { ...query }, { ownerType: 'user', ownerId: ctx.principal.id });

export const getEndpoint = async (ctx: ReadCtx, id: string): Promise<Row> =>
  requireOwn(ctx.deps.store, ctx.principal.id, id);

/** An endpoint may only include installations the caller may manage (their own and their teams'). */
const assertInstallationsUsable = async (
  ctx: Pick<WriteCtx, 'deps' | 'can'>,
  ids: readonly string[],
): Promise<void> => {
  for (const id of ids) {
    const resource = await loadInstallationResource(ctx.deps, id);
    if (!resource || !ctx.can('installation.manage', resource)) {
      throw new ValidationApiError('an installation is not available to you', [
        { path: '/installationIds', message: `unknown installation ${id}` },
      ]);
    }
  }
};

const assertSlug = async (ctx: WriteCtx, slug: string, exceptId?: string): Promise<void> => {
  if (!isValidSlug(slug)) {
    throw new ValidationApiError('the slug is not valid', [
      { path: '/slug', message: 'use lowercase letters, digits and dashes' },
    ]);
  }
  const clash = await ctx.tx.store.find('endpoints', {
    ownerType: 'user',
    ownerId: ctx.principal.id,
    slug,
  });
  if (clash.some((r) => r.id !== exceptId)) {
    throw new ConflictApiError('you already have an endpoint with this slug', 'slug_collision');
  }
};

export const createEndpoint = async (
  ctx: WriteCtx,
  body: {
    slug: string;
    displayName: string;
    installationIds: string[];
    prefixMode: string;
    instructions?: string | undefined;
  },
): Promise<Row> => {
  await assertSlug(ctx, body.slug);
  await assertInstallationsUsable(ctx, body.installationIds);
  const { instructions, ...rest } = body;
  return endpoints.create(ctx, {
    ...rest,
    ...(instructions === undefined ? {} : { instructions }),
    ownerType: 'user',
    ownerId: ctx.principal.id,
  });
};

export const updateEndpoint = async (
  ctx: WriteCtx,
  id: string,
  patch: Record<string, unknown>,
): Promise<Row> => {
  await requireOwn(ctx.tx.store, ctx.principal.id, id);
  if (typeof patch.slug === 'string') await assertSlug(ctx, patch.slug, id);
  if (Array.isArray(patch.installationIds)) {
    await assertInstallationsUsable(ctx, patch.installationIds.map(String));
  }
  return endpoints.update(ctx, id, patch);
};

export const deleteEndpoint = async (ctx: WriteCtx, id: string): Promise<void> => {
  await requireOwn(ctx.tx.store, ctx.principal.id, id);
  return endpoints.remove(ctx, id);
};

export const endpointClientConfig = async (
  ctx: ReadCtx,
  id: string,
  client: ClientKind,
  auth: ClientAuth,
) => {
  const row = await requireOwn(ctx.deps.store, ctx.principal.id, id);
  return clientConfigFor(
    client,
    { baseUrl: ctx.deps.config.baseUrl, slug: String(row.slug), kind: 'named' },
    auth,
  );
};

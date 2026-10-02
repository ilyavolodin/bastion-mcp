import { isValidSlug } from '@bastion-mcp/core';
import { type RolloutClient, renderRollout } from '@bastion-mcp/plugins';
import type { ResourceData } from '@bastion-mcp/policy';
import { ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import { pageOfArray } from '../framework/conventions';
import type { AuthzInput, ResourceChoice } from '../framework/route';
import type { ApiDeps } from '../ports';
import type { Page, Row } from '../ports/store';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';
import { catalogEntryResource, orgResource, teamResource } from './resources';

export const marketplaces = new CrudService({
  collection: 'marketplaces',
  targetType: 'marketplace',
  action: 'marketplace',
  unique: 'slug',
  configTopic: 'marketplaces',
});

/** Policy id of a marketplace: the policy data lists each audience as visibility of this pseudo entry. */
export const marketplaceEntryId = (id: string): string => `marketplace:${id}`;

/**
 * Reads authorize `seeCatalog` on the pseudo catalog entry `marketplace:{id}` whose visibility is the
 * marketplace audience, so the Cedar visibility policies decide who sees a marketplace (25.4). The
 * `PolicyDataSource` must emit that entry (owner team and audience) for every marketplace.
 */
export const marketplaceResource = (row: Row): ResourceData =>
  catalogEntryResource({
    id: marketplaceEntryId(row.id),
    updatedAt: row.updatedAt,
    ...(typeof row.ownerTeamId === 'string' ? { ownerTeamId: row.ownerTeamId } : {}),
    visibility: row.audience,
    risk: 'low',
  });

/** Reads: the audience decides; a missing marketplace is checked against the org (answers 404 to admins only). */
export const readChoice = async (input: AuthzInput): Promise<ResourceChoice> => {
  const row = await input.deps.store.get('marketplaces', input.params.id ?? '');
  return { rule: 'catalog.read', resource: row ? marketplaceResource(row) : orgResource() };
};

/** Writes: the owning team's managers or, for org-owned marketplaces, admins (10.1). Never the body. */
export const writeChoice = async (input: AuthzInput): Promise<ResourceChoice> => {
  const row = await input.deps.store.get('marketplaces', input.params.id ?? '');
  return ownerChoice(row);
};

export const ownerChoice = (row: Row | null): ResourceChoice =>
  row && typeof row.ownerTeamId === 'string'
    ? { rule: 'marketplaces.write.team', resource: teamResource(row.ownerTeamId) }
    : { rule: 'marketplaces.write.org', resource: orgResource() };

export const listMarketplaces = async (
  ctx: ReadCtx,
  query: {
    limit: number;
    cursor?: string | undefined;
    q?: string | undefined;
    sort?: string | undefined;
  },
): Promise<Page<Row>> => {
  const page = await marketplaces.list(ctx, {
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  });
  return {
    items: page.items.filter((row) => ctx.can('seeCatalog', marketplaceResource(row))),
    nextCursor: page.nextCursor,
  };
};

export const createMarketplace = async (
  ctx: WriteCtx,
  body: {
    slug: string;
    displayName: string;
    description: string | null;
    ownerTeamId: string | null;
    audience: { org: boolean; teamIds: string[]; userIds: string[] };
    desktopInstallation: string;
  },
): Promise<Row> => {
  if (!isValidSlug(body.slug)) {
    throw new ValidationApiError('the slug is not valid', [
      { path: '/slug', message: 'use lowercase letters, digits and dashes' },
    ]);
  }
  if (body.ownerTeamId && !(await ctx.tx.store.get('teams', body.ownerTeamId))) {
    throw new NotFoundApiError('team');
  }
  return marketplaces.create(ctx, {
    ...body,
    mirror: null,
    mirrorStatus: null,
    promotedRelease: null,
    createdBy: ctx.principal.id,
  });
};

/** Create authorizes on the team named in the body, which is also the owner that is stored. */
export const createChoice = (input: AuthzInput): ResourceChoice => {
  const owner = (input.body as { ownerTeamId?: unknown } | null | undefined)?.ownerTeamId;
  return typeof owner === 'string' && owner.length > 0
    ? { rule: 'marketplaces.write.team', resource: teamResource(owner) }
    : { rule: 'marketplaces.write.org', resource: orgResource() };
};

export const deleteMarketplace = async (ctx: WriteCtx, id: string): Promise<void> => {
  const items = await ctx.tx.store.find('marketplace_items', { marketplaceId: id });
  for (const item of items) await ctx.tx.store.remove('marketplace_items', item.id);
  await marketplaces.remove(ctx, id);
};

export const itemId = (marketplaceId: string, entryId: string): string =>
  `${marketplaceId}:${entryId}`;

/** A new release is cut after commit so it sees the committed items (25.4); a failure is retried by the next change. */
const publishAfterCommit = (ctx: WriteCtx, marketplaceId: string): void => {
  ctx.tx.afterCommit(async () => {
    try {
      await ctx.deps.plugins.releaseService.publish(marketplaceId, ctx.principal.id);
    } catch {
      // The items are saved; the next item change or mirror push cuts the release.
    }
  });
};

export const putItem = async (
  ctx: WriteCtx,
  marketplaceId: string,
  entryId: string,
  body: { policy: string; pinnedVersionId: string | null; position?: number | undefined },
): Promise<Row> => {
  if (!(await ctx.tx.store.get('marketplaces', marketplaceId)))
    throw new NotFoundApiError('marketplace');
  if (!(await ctx.tx.store.get('catalog_entries', entryId)))
    throw new NotFoundApiError('catalog entry');
  const id = itemId(marketplaceId, entryId);
  const existing = await ctx.tx.store.get('marketplace_items', id);
  const count = (await ctx.tx.store.find('marketplace_items', { marketplaceId })).length;
  const row = await ctx.tx.store.upsert('marketplace_items', id, {
    marketplaceId,
    catalogEntryId: entryId,
    policy: body.policy,
    pinnedVersionId: body.pinnedVersionId,
    position: body.position ?? (typeof existing?.position === 'number' ? existing.position : count),
  });
  await ctx.tx.audit({
    action: 'marketplace.item.set',
    targetType: 'marketplace',
    targetId: marketplaceId,
    diff: { entryId, policy: body.policy, pinnedVersionId: body.pinnedVersionId },
  });
  publishAfterCommit(ctx, marketplaceId);
  return row;
};

export const removeItem = async (
  ctx: WriteCtx,
  marketplaceId: string,
  entryId: string,
): Promise<void> => {
  const removed = await ctx.tx.store.remove('marketplace_items', itemId(marketplaceId, entryId));
  if (!removed) throw new NotFoundApiError('marketplace item');
  await ctx.tx.audit({
    action: 'marketplace.item.remove',
    targetType: 'marketplace',
    targetId: marketplaceId,
    diff: { entryId },
  });
  publishAfterCommit(ctx, marketplaceId);
};

const requirePluginRow = async (deps: ApiDeps, id: string) => {
  const row = await deps.plugins.marketplaces.getById(id);
  if (!row) throw new NotFoundApiError('marketplace');
  return row;
};

export const listReleases = async (
  ctx: Pick<ReadCtx, 'deps'>,
  id: string,
  query: { limit: number; cursor?: string | undefined },
) => {
  const marketplace = await requirePluginRow(ctx.deps, id);
  const all = (await ctx.deps.plugins.releases.list(id)).sort((a, b) => b.seq - a.seq);
  const page = pageOfArray(all, query);
  return {
    items: page.items.map((r) => ({ ...r, promoted: marketplace.promotedRelease === r.seq })),
    nextCursor: page.nextCursor,
  };
};

export const promoteRelease = async (ctx: WriteCtx, id: string, seq: number) => {
  await requirePluginRow(ctx.deps, id);
  const record = await ctx.deps.plugins.releaseService.promote(id, seq);
  await ctx.tx.audit({
    action: 'marketplace.release.promote',
    targetType: 'marketplace',
    targetId: id,
    diff: { seq },
  });
  ctx.tx.configChanged('marketplaces');
  return { ...record, promoted: true };
};

export const getMirror = async (ctx: Pick<ReadCtx, 'deps'>, id: string) => {
  const row = await marketplaces.require(ctx, id);
  const plugin = await requirePluginRow(ctx.deps, id);
  return { mirror: plugin.mirror, status: plugin.mirrorStatus, updatedAt: row.updatedAt };
};

export const putMirror = async (
  ctx: WriteCtx,
  id: string,
  body: { provider: 'github' | 'gitlab'; repo: string; branch: string; credentialSecretId: string },
) => {
  if (!(await ctx.tx.store.get('marketplaces', id))) throw new NotFoundApiError('marketplace');
  await ctx.tx.store.update('marketplaces', id, { mirror: body, mirrorStatus: null });
  await ctx.tx.audit({
    action: 'marketplace.mirror.set',
    targetType: 'marketplace',
    targetId: id,
    diff: { provider: body.provider, repo: body.repo, branch: body.branch },
  });
  ctx.tx.configChanged('marketplaces');
  return getMirror({ deps: ctx.deps }, id);
};

export const pushMirror = async (ctx: WriteCtx, id: string) => {
  const plugin = await requirePluginRow(ctx.deps, id);
  if (!plugin.mirror)
    throw new ConflictApiError('no mirror is configured', 'mirror_not_configured');
  const state = await ctx.deps.plugins.mirror.push(id, { force: true });
  await ctx.tx.audit({
    action: 'marketplace.mirror.push',
    targetType: 'marketplace',
    targetId: id,
    diff: { status: state.status, lastPushedSeq: state.lastPushedSeq },
  });
  return state;
};

/** Copy-ready client configuration (25.7); Claude Desktop pins the promoted release. */
export const rollout = async (ctx: Pick<ReadCtx, 'deps'>, id: string, client: RolloutClient) => {
  const marketplace = await requirePluginRow(ctx.deps, id);
  const release =
    client === 'claude-desktop-3p' && marketplace.promotedRelease !== null
      ? await ctx.deps.plugins.releases.get(id, marketplace.promotedRelease)
      : await ctx.deps.plugins.releases.latest(id);
  if (!release) throw new ConflictApiError('the marketplace has no release yet', 'no_release');
  return renderRollout(marketplace, release, client, {
    host: ctx.deps.plugins.host,
    ...(ctx.deps.plugins.credentialHelperPath
      ? { credentialHelperPath: ctx.deps.plugins.credentialHelperPath }
      : {}),
  });
};

export const usage = async (
  ctx: Pick<ReadCtx, 'deps'>,
  id: string,
  range: { from?: string | undefined; to?: string | undefined },
) => {
  await requirePluginRow(ctx.deps, id);
  return ctx.deps.plugins.usage(id, range);
};

import type { CreatePatInput, PatRecord } from '@bastion-mcp/auth';
import { parseRule, subjectIdsFor, type Usage } from '@bastion-mcp/limits';
import { ApiError, NotFoundApiError } from '../errors';
import type { Row } from '../ports/store';
import { nowIso, type ReadCtx, type WriteCtx } from './crud';
import { orgResource } from './resources';
import { getSettings } from './settings';

export type MeView = {
  id: string;
  type: 'user' | 'service';
  orgRole: string;
  authMethod: string;
  scopes: string[];
  email?: string;
  displayName: string;
  status: string;
  teams: Array<{ teamId: string; role: string; slug?: string; displayName?: string }>;
  /** Org display data the console needs without the Admin-only `/settings` (18). */
  org: { name: string; host: string; traceUiUrl: string | null; toolWarnThreshold: number };
  /** Cedar-derived flags the UI cannot infer from the role (10.1, 11.7). */
  capabilities: {
    registry: boolean;
    publishOrgWide: boolean;
    personalInstalls: 'off' | 'remoteOnly' | 'all';
  };
  updatedAt: string;
};

/** `GET /me`: the caller with role, team memberships (names resolved) and token scopes (17.2). */
export const getMe = async (ctx: ReadCtx): Promise<MeView> => {
  const { principal, deps } = ctx;
  const isService = principal.type === 'service';
  const row = await deps.store.get(isService ? 'service_accounts' : 'users', principal.id);
  if (!row) throw new NotFoundApiError('principal');
  const teams = await Promise.all(
    principal.teams.map(async (t) => {
      const team = await deps.store.get('teams', t.teamId);
      return {
        teamId: t.teamId,
        role: t.role,
        ...(typeof team?.slug === 'string' ? { slug: team.slug } : {}),
        ...(typeof team?.displayName === 'string' ? { displayName: team.displayName } : {}),
      };
    }),
  );
  const { settings } = await getSettings(deps);
  const org = orgResource();
  return {
    id: principal.id,
    type: principal.type,
    orgRole: principal.orgRole,
    authMethod: principal.authMethod,
    scopes: [...principal.scopes],
    ...(typeof row.email === 'string' ? { email: row.email } : {}),
    displayName: String(row.displayName ?? row.slug ?? principal.id),
    status: String(row.status ?? 'active'),
    teams,
    org: {
      name: settings.org.displayName,
      host: new URL(deps.config.baseUrl).host,
      traceUiUrl: deps.config.traceUiUrl ?? null,
      toolWarnThreshold: settings.endpoints.toolWarnThreshold,
    },
    capabilities: {
      registry: ctx.can('registry.install', org),
      publishOrgWide: ctx.can('catalog.publish', org),
      personalInstalls: settings.personalInstalls,
    },
    updatedAt: row.updatedAt,
  };
};

export const meVersion = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
): Promise<string | null> => {
  const collection = ctx.principal.type === 'service' ? 'service_accounts' : 'users';
  return (await ctx.deps.store.get(collection, ctx.principal.id))?.updatedAt ?? null;
};

/** `PATCH /me`: users change only their own display name; roles are managed by admins (10.1). */
export const updateMe = async (ctx: WriteCtx, patch: { displayName?: string | undefined }) => {
  if (ctx.principal.type === 'service') {
    throw new ApiError(
      'not_supported',
      'service accounts are managed by their team managers, not through /me',
      422,
    );
  }
  const changes: Record<string, unknown> = {};
  if (patch.displayName !== undefined) changes.displayName = patch.displayName;
  const row = await ctx.tx.store.update('users', ctx.principal.id, changes);
  await ctx.tx.audit({
    action: 'user.update_self',
    targetType: 'user',
    targetId: ctx.principal.id,
    diff: { changed: Object.keys(changes) },
  });
  return { ...(await getMe(ctx)), updatedAt: row.updatedAt };
};

export const listNotifications = (
  ctx: ReadCtx,
  query: { limit: number; cursor?: string | undefined; unread?: boolean | undefined },
) =>
  ctx.deps.store.list('notifications', {
    limit: query.limit,
    cursor: query.cursor,
    sort: { field: 'createdAt', desc: true },
    where: { userId: ctx.principal.id, ...(query.unread ? { readAt: null } : {}) },
  });

export const markNotificationRead = async (ctx: WriteCtx, id: string): Promise<Row> => {
  const row = await ctx.tx.store.get('notifications', id);
  if (!row || row.userId !== ctx.principal.id) throw new NotFoundApiError('notification');
  const updated =
    row.readAt == null
      ? await ctx.tx.store.update('notifications', id, { readAt: nowIso(ctx.deps) })
      : row;
  await ctx.tx.audit({
    action: 'notification.read',
    targetType: 'notification',
    targetId: id,
  });
  return updated;
};

export type QuotaView = Usage & { name: string; metric: string; subject: string };

/** `GET /me/quotas`: current consumption of every limit rule that applies to the caller (14, 17.2). */
export const myQuotas = async (ctx: ReadCtx): Promise<QuotaView[]> => {
  const { principal, deps } = ctx;
  const page = await deps.store.list('limit_rules', { limit: 500 });
  const roleIds = [
    principal.orgRole,
    ...(principal.teams.some((t) => t.role === 'manager') ? ['manager'] : []),
  ];
  const subject = {
    orgId: 'org',
    ...(principal.type === 'user' ? { userId: principal.id } : { serviceAccountId: principal.id }),
    teamIds: principal.teams.map((t) => t.teamId),
    roleIds,
    ...(principal.clientId ? { clientId: principal.clientId } : {}),
  };
  const out: QuotaView[] = [];
  for (const row of page.items) {
    const parsed = parseRuleSafe(row);
    if (!parsed?.enabled) continue;
    for (const subjectId of subjectIdsFor(parsed, subject)) {
      const usage = await deps.limits.readUsage(parsed, subjectId);
      out.push({ ...usage, name: parsed.name, metric: parsed.metric, subject: parsed.subject });
    }
  }
  return out;
};

const parseRuleSafe = (row: Row) => {
  try {
    return parseRule(row);
  } catch {
    return null;
  }
};

export type TokenView = {
  id: string;
  name: string;
  scopes: string[];
  endpointId: string | null;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PatView = Omit<PatRecord, 'tokenSha256'>;

const tokenView = (pat: PatView): TokenView => ({
  id: pat.id,
  name: pat.name,
  scopes: [...pat.scopes],
  endpointId: pat.endpointId,
  expiresAt: pat.expiresAt.toISOString(),
  lastUsedAt: pat.lastUsedAt?.toISOString() ?? null,
  revokedAt: pat.revokedAt?.toISOString() ?? null,
  createdAt: pat.createdAt.toISOString(),
  updatedAt: (pat.revokedAt ?? pat.createdAt).toISOString(),
});

export const listTokens = async (ctx: ReadCtx): Promise<TokenView[]> =>
  (await ctx.deps.pats.list(ctx.principal.id)).map((p) => tokenView(p));

export const tokenVersion = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  id: string,
): Promise<string | null> =>
  (await listTokens(ctx as ReadCtx)).find((t) => t.id === id)?.updatedAt ?? null;

export const createToken = async (
  ctx: WriteCtx,
  body: Pick<CreatePatInput, 'name' | 'scopes'> & {
    expiresInDays?: number | undefined;
    endpointId?: string | undefined;
  },
): Promise<{ token: string; metadata: TokenView }> => {
  const input: CreatePatInput = {
    principalId: ctx.principal.id,
    principalType: ctx.principal.type,
    name: body.name,
    scopes: body.scopes,
    ...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
    ...(body.endpointId === undefined ? {} : { endpointId: body.endpointId }),
  };
  const { token, record } = await ctx.deps.pats.create(input);
  await ctx.tx.audit({
    action: 'token.create',
    targetType: 'token',
    targetId: record.id,
    diff: { name: record.name, scopes: record.scopes, expiresAt: record.expiresAt.toISOString() },
  });
  const { tokenSha256: _hash, ...rest } = record;
  return { token, metadata: tokenView({ ...rest }) };
};

export const revokeToken = async (ctx: WriteCtx, id: string): Promise<void> => {
  await ctx.deps.pats.revoke(id, { ownerId: ctx.principal.id });
  await ctx.tx.audit({ action: 'token.revoke', targetType: 'token', targetId: id });
};

export const listGrants = (ctx: ReadCtx, query: { limit: number; cursor?: string | undefined }) =>
  ctx.deps.store.list('oauth_grants', {
    limit: query.limit,
    cursor: query.cursor,
    where: { userId: ctx.principal.id },
  });

export const grantVersion = async (
  ctx: Pick<ReadCtx, 'deps' | 'principal'>,
  id: string,
): Promise<string | null> => {
  const row = await ctx.deps.store.get('oauth_grants', id);
  return row && row.userId === ctx.principal.id ? row.updatedAt : null;
};

/** Revoking a grant removes the refresh tokens of that client for the caller (9.4). */
export const revokeGrant = async (ctx: WriteCtx, id: string): Promise<void> => {
  const row = await ctx.tx.store.get('oauth_grants', id);
  if (!row || row.userId !== ctx.principal.id) throw new NotFoundApiError('grant');
  await ctx.tx.store.remove('oauth_grants', id);
  await ctx.tx.audit({
    action: 'oauth_grant.revoke',
    targetType: 'oauth_grant',
    targetId: id,
    diff: { clientId: row.clientId },
  });
};

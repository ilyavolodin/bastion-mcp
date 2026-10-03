import { type DeactivationAction, executeDeactivation, planDeactivation } from '@bastion-mcp/auth';
import { isValidSlug } from '@bastion-mcp/core';
import RE2 from 're2';
import { ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import type { Row } from '../ports/store';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';

export const users = new CrudService({
  collection: 'users',
  targetType: 'user',
  action: 'user',
  unique: 'email',
  configTopic: 'users',
});

export const teams = new CrudService({
  collection: 'teams',
  targetType: 'team',
  action: 'team',
  unique: 'slug',
  configTopic: 'teams',
});

export const roleMappingRules = new CrudService({
  collection: 'role_mapping_rules',
  targetType: 'role_mapping_rule',
  action: 'role_mapping_rule',
  configTopic: 'role_mapping_rules',
});

const assertSlug = (slug: string | undefined): void => {
  if (slug !== undefined && !isValidSlug(slug)) {
    throw new ValidationApiError('the slug is not valid', [
      { path: '/slug', message: 'use lowercase letters, digits and dashes' },
    ]);
  }
};

/** Group patterns run on RE2 at login (9.1); reject patterns that cannot compile when saved. */
export const assertGroupPattern = (pattern: string | undefined): void => {
  if (pattern === undefined) return;
  try {
    new RE2(`^(?:${pattern})$`, 'u');
  } catch {
    throw new ValidationApiError('the group pattern is not a valid RE2 expression', [
      { path: '/groupPattern', message: 'invalid pattern' },
    ]);
  }
};

/**
 * An organization always keeps an active administrator: taking the role from, or deactivating, the last one would
 * leave nobody who can change it back (the local break-glass account may be switched off, 9.1).
 */
const assertAnotherAdmin = async (ctx: WriteCtx, userId: string): Promise<void> => {
  const admins = await ctx.tx.store.find('users', { orgRole: 'admin', status: 'active' });
  if (!admins.some((a) => a.id !== userId)) {
    throw new ConflictApiError(
      'this is the last active administrator: make somebody else an administrator first',
      { code: 'last_admin' },
    );
  }
};

/** `PATCH /users/{id}`: a role change keeps at least one active administrator. */
export const updateUser = async (
  ctx: WriteCtx,
  id: string,
  patch: Record<string, unknown>,
): Promise<Row> => {
  if (patch.orgRole !== undefined && patch.orgRole !== 'admin') {
    const current = await ctx.tx.store.get('users', id);
    if (current?.orgRole === 'admin' && current.status === 'active') {
      await assertAnotherAdmin(ctx, id);
    }
  }
  return users.update(ctx, id, patch);
};

export const createUser = (
  ctx: WriteCtx,
  body: { email: string; displayName: string; orgRole: string },
) => users.create(ctx, { ...body, status: 'active', catalogPublishOrgWide: false });

/** 9.1 deactivation: mark the user, then revoke tokens and sessions and stop their instances. */
export const deactivateUser = async (ctx: WriteCtx, id: string): Promise<Row> => {
  const user = await ctx.tx.store.get('users', id);
  if (!user) throw new NotFoundApiError('user');
  if (user.status === 'deactivated') {
    await ctx.tx.audit({
      action: 'user.deactivate',
      targetType: 'user',
      targetId: id,
      diff: { noop: true },
    });
    return user;
  }
  if (id === ctx.principal.id) {
    throw new ConflictApiError('you cannot deactivate your own account', {
      code: 'cannot_deactivate_self',
    });
  }
  if (user.orgRole === 'admin') await assertAnotherAdmin(ctx, id);
  const row = await ctx.tx.store.update('users', id, { status: 'deactivated' });
  await ctx.tx.audit({
    action: 'user.deactivate',
    targetType: 'user',
    targetId: id,
    diff: { status: ['active', 'deactivated'] },
  });
  const plan = planDeactivation({ principalId: id });
  const skip: DeactivationAction['type'][] = ['mark_deactivated'];
  const remaining = { ...plan, actions: plan.actions.filter((a) => !skip.includes(a.type)) };
  ctx.tx.afterCommit(async () => {
    await executeDeactivation(remaining, ctx.deps.deactivation);
  });
  ctx.tx.configChanged('users');
  return row;
};

export const createTeam = (
  ctx: WriteCtx,
  body: { slug: string; displayName: string; idpGroup?: string | null | undefined },
) => {
  assertSlug(body.slug);
  return teams.create(ctx, { ...body, idpGroup: body.idpGroup ?? null });
};

export const updateTeam = (ctx: WriteCtx, id: string, patch: Record<string, unknown>) => {
  assertSlug(typeof patch.slug === 'string' ? patch.slug : undefined);
  return teams.update(ctx, id, patch);
};

/** Deleting a team removes its memberships in the same transaction. */
export const deleteTeam = async (ctx: WriteCtx, id: string): Promise<void> => {
  const members = await ctx.tx.store.find('team_members', { teamId: id });
  for (const member of members) await ctx.tx.store.remove('team_members', member.id);
  await teams.remove(ctx, id);
};

export const listMembers = async (ctx: Pick<ReadCtx, 'deps'>, teamId: string): Promise<Row[]> => {
  await teams.require(ctx, teamId);
  return ctx.deps.store.find('team_members', { teamId });
};

export const setMember = async (
  ctx: WriteCtx,
  teamId: string,
  userId: string,
  role: 'manager' | 'member',
): Promise<Row> => {
  if (!(await ctx.tx.store.get('teams', teamId))) throw new NotFoundApiError('team');
  if (!(await ctx.tx.store.get('users', userId))) throw new NotFoundApiError('user');
  const row = await ctx.tx.store.upsert('team_members', `${teamId}:${userId}`, {
    teamId,
    userId,
    role,
    source: 'manual',
  });
  await ctx.tx.audit({
    action: 'team.member.set',
    targetType: 'team',
    targetId: teamId,
    diff: { userId, role },
  });
  ctx.tx.configChanged('teams');
  return row;
};

export const removeMember = async (
  ctx: WriteCtx,
  teamId: string,
  userId: string,
): Promise<void> => {
  const removed = await ctx.tx.store.remove('team_members', `${teamId}:${userId}`);
  if (!removed) throw new NotFoundApiError('membership');
  await ctx.tx.audit({
    action: 'team.member.remove',
    targetType: 'team',
    targetId: teamId,
    diff: { userId },
  });
  ctx.tx.configChanged('teams');
};

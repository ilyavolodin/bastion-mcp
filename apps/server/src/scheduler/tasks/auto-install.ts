import { createInstallationRepository } from '@bastion-mcp/db';
import { z } from 'zod';
import type { TaskContext, TaskFn } from '../types';
import { BATCH_SIZE } from '../types';

type Subject = { type: 'user' | 'team'; id: string };

const policyPayload = z.object({ policyId: z.string().uuid(), afterId: z.string().optional() });
const userPayload = z.object({ userId: z.string().uuid() });

const needsSetup = (spec: unknown, installForm: unknown): boolean => {
  const mode = (spec as { auth?: { mode?: string } } | null)?.auth?.mode;
  if (mode === 'userSecret' || mode === 'oauth') return true;
  return JSON.stringify(installForm ?? null).includes('"required":true');
};

/**
 * Creates the installation of one subject for one policy, inside `applyOnce` so it happens at most once (11.5).
 * Returns the ledger result: `installed`, `exists` (the owner already had that slug) or `skipped`.
 */
type PolicyContext = {
  policyId: string;
  entry: { id: string; slug: string; displayName: string };
  version: { id: string; serverSpec: unknown; installForm: unknown };
};

/** Loads what applying a policy needs once per batch; null when the policy or entry cannot install now. */
const loadPolicyContext = async (
  ctx: TaskContext,
  policyId: string,
): Promise<PolicyContext | null> => {
  const { repos, db } = ctx.infra;
  const policy = await repos.autoInstall.get(policyId);
  if (!policy?.enabled) return null;
  const entry = await db.prisma.catalogEntry.findUnique({ where: { id: policy.catalogEntryId } });
  if (!entry || entry.status !== 'published' || !entry.currentVersionId) return null;
  const version = await db.prisma.catalogVersion.findUnique({
    where: { id: entry.currentVersionId },
  });
  if (!version) return null;
  return { policyId, entry, version };
};

const applyPolicy = async (
  ctx: TaskContext,
  pc: PolicyContext,
  subject: Subject,
): Promise<string> => {
  const { repos } = ctx.infra;
  const { policyId, entry, version } = pc;
  const outcome = await repos.autoInstall.applyOnce(
    { policyId, subjectType: subject.type, subjectId: subject.id },
    async (tx) => {
      const installs = createInstallationRepository(tx);
      const existing = await installs.getByOwnerSlug(subject.type, subject.id, entry.slug);
      if (existing) return { installationId: existing.id, result: 'exists' };
      const created = await installs.create(
        {
          ownerType: subject.type,
          ownerId: subject.id,
          catalogEntryId: entry.id,
          catalogVersionId: version.id,
          pinnedVersion: false,
          slug: entry.slug,
          displayName: entry.displayName,
          origin: `autoInstall:${policyId}`,
          status: needsSetup(version.serverSpec, version.installForm) ? 'needs_setup' : 'ready',
        },
        { actorType: 'system', actorId: null },
      );
      return { installationId: created.id, result: 'installed' };
    },
  );
  return outcome.applied ? outcome.result : 'noop';
};

/**
 * `auto-install:policy` (11.5): one batch of up to 500 subjects of a policy, then a follow-up job for the next batch,
 * so a policy over a large org never holds one long job. Users who already have a ledger row are skipped by the
 * query; the ledger makes a repeated batch harmless.
 */
export const autoInstallPolicy: TaskFn<unknown> = async (ctx, raw) => {
  const { policyId, afterId } = policyPayload.parse(raw);
  const { repos, db } = ctx.infra;
  const policy = await repos.autoInstall.get(policyId);
  if (!policy?.enabled) return { skipped: true };
  const pc = await loadPolicyContext(ctx, policyId);
  if (!pc) return { skipped: true };
  const counts = { installed: 0, exists: 0, skipped: 0 };
  const count = (result: string) => {
    if (result === 'installed') counts.installed += 1;
    else if (result === 'exists') counts.exists += 1;
    else counts.skipped += 1;
  };

  if (policy.scope === 'team') {
    for (const teamId of await repos.autoInstall.listTargetTeams(policyId)) {
      count(await applyPolicy(ctx, pc, { type: 'team', id: teamId }));
    }
    return { scope: 'team', ...counts };
  }

  const ids = await repos.autoInstall.listTargetUsers(policyId, {
    limit: BATCH_SIZE,
    onlyUnapplied: true,
    ...(afterId ? { afterId } : {}),
  });
  // `applyToExisting: false` means only users created after the policy, plus later joiners.
  const eligible = policy.applyToExisting
    ? ids
    : (
        await db.prisma.user.findMany({
          where: { id: { in: ids }, createdAt: { gte: policy.createdAt } },
          select: { id: true },
        })
      ).map((u) => u.id);
  for (const userId of eligible) count(await applyPolicy(ctx, pc, { type: 'user', id: userId }));
  const last = ids.at(-1);
  if (ids.length === BATCH_SIZE && last) {
    await ctx.enqueue('auto-install:policy', { policyId, afterId: last });
  }
  return { scope: 'user', batch: ids.length, ...counts };
};

/** True when the policy targets this user (the same rules as `listTargetUsers`). */
const isTargeted = async (ctx: TaskContext, policyId: string, userId: string): Promise<boolean> => {
  const prisma = ctx.infra.db.prisma;
  const row = await prisma.autoInstallPolicy.findUnique({ where: { id: policyId } });
  if (!row) return false;
  const target = z
    .object({
      all: z.boolean().optional(),
      teamIds: z.array(z.string()).optional(),
      orgRoles: z.array(z.string()).optional(),
      idpGroups: z.array(z.string()).optional(),
    })
    .parse(row.target);
  if (target.all) return true;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgRole: true } });
  if (!user) return false;
  if (target.orgRoles?.includes(user.orgRole)) return true;
  const memberships = await prisma.teamMembership.findMany({
    where: { userId },
    select: { teamId: true, team: { select: { idpGroup: true } } },
  });
  return memberships.some(
    (m) =>
      target.teamIds?.includes(m.teamId) ||
      (m.team.idpGroup !== null && target.idpGroups?.includes(m.team.idpGroup)),
  );
};

/** `auto-install:user` (11.5): a user was provisioned or joined a team or group; apply every user-scope policy. */
export const autoInstallUser: TaskFn<unknown> = async (ctx, raw) => {
  const { userId } = userPayload.parse(raw);
  const { repos } = ctx.infra;
  const user = await repos.users.get(userId);
  if (!user || user.status !== 'active') return { skipped: true };
  let installed = 0;
  for (const policy of await repos.autoInstall.listEnabledForUserScope()) {
    if (!(await isTargeted(ctx, policy.id, userId))) continue;
    const pc = await loadPolicyContext(ctx, policy.id);
    if (pc && (await applyPolicy(ctx, pc, { type: 'user', id: userId })) === 'installed')
      installed += 1;
  }
  return { installed };
};

/** Nightly reconciliation (11.5): every enabled policy gets a fan-out job; applied subjects are skipped. */
export const autoInstallReconcile: TaskFn = async (ctx) => {
  const policies = await ctx.infra.repos.autoInstall.list({ enabled: true });
  for (const policy of policies) {
    await ctx.enqueue(
      'auto-install:policy',
      { policyId: policy.id },
      { jobKey: `auto-install:${policy.id}` },
    );
  }
  return { policies: policies.length };
};

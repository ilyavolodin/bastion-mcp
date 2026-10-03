import { AUTO_INSTALL_MODES, AUTO_INSTALL_SCOPES, newId, ORG_ROLES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { Prisma } from '../generated/client';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  etagOf,
  mutate,
  NotFoundError,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  ValidationError,
  versionedUpdate,
  versionGuard,
} from './support';

// --- auto-install policies (11.5) ---------------------------------------------------------------------------------------------------------

/** Who a policy targets; present fields combine as a union (11.5). */
export const autoInstallTargetSchema = z.object({
  all: z.boolean().optional(),
  teamIds: z.array(z.string().uuid()).optional(),
  orgRoles: z.array(z.enum(ORG_ROLES)).optional(),
  idpGroups: z.array(z.string().min(1)).optional(),
});
export type AutoInstallTarget = z.infer<typeof autoInstallTargetSchema>;

export type AutoInstallPolicyView = {
  id: string;
  catalogEntryId: string;
  target: AutoInstallTarget;
  mode: (typeof AUTO_INSTALL_MODES)[number];
  scope: (typeof AUTO_INSTALL_SCOPES)[number];
  applyToExisting: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const modeSchema = z.enum(AUTO_INSTALL_MODES);
const scopeSchema = z.enum(AUTO_INSTALL_SCOPES);

const toPolicyView = (row: {
  id: string;
  catalogEntryId: string;
  target: unknown;
  mode: string;
  scope: string;
  applyToExisting: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
}): AutoInstallPolicyView => ({
  id: row.id,
  catalogEntryId: row.catalogEntryId,
  target: autoInstallTargetSchema.parse(row.target),
  mode: modeSchema.parse(row.mode),
  scope: scopeSchema.parse(row.scope),
  applyToExisting: row.applyToExisting,
  enabled: row.enabled,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type AutoInstallApplicationView = {
  policyId: string;
  subjectType: 'user' | 'team';
  subjectId: string;
  installationId: string | null;
  result: string;
  appliedAt: Date;
};

export type ApplyOnceResult = {
  /** True only for the call that recorded the application and therefore ran `run`. */
  applied: boolean;
  installationId: string | null;
  result: string;
};

const subjectTypeSchema = z.enum(['user', 'team']);

const targetWhere = (target: AutoInstallTarget): Prisma.UserWhereInput => {
  if (target.all) return {};
  const or: Prisma.UserWhereInput[] = [];
  if (target.teamIds?.length)
    or.push({ teamMemberships: { some: { teamId: { in: target.teamIds } } } });
  if (target.orgRoles?.length) or.push({ orgRole: { in: target.orgRoles } });
  if (target.idpGroups?.length) {
    or.push({ teamMemberships: { some: { team: { idpGroup: { in: target.idpGroups } } } } });
  }
  return or.length === 0 ? { id: { in: [] } } : { OR: or };
};

/** `auto_install_policies` and the idempotent `auto_install_applications` ledger (11.5). */
/** `listTargetUsers` reads at least this many users per query. */
const MIN_TARGET_PAGE_SIZE = 100;

export const createAutoInstallRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<AutoInstallPolicyView | null> {
      const row = await db.autoInstallPolicy.findUnique({ where: { id } });
      return row ? toPolicyView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ policy: AutoInstallPolicyView; etag: string } | null> {
      const row = await db.autoInstallPolicy.findUnique({ where: { id } });
      return row ? { policy: toPolicyView(row), etag: etagOf(row) } : null;
    },
    async list(
      filter: { catalogEntryId?: string; enabled?: boolean } = {},
    ): Promise<AutoInstallPolicyView[]> {
      const rows = await db.autoInstallPolicy.findMany({
        where: {
          ...(filter.catalogEntryId ? { catalogEntryId: filter.catalogEntryId } : {}),
          ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toPolicyView);
    },

    async create(
      input: {
        id?: string;
        catalogEntryId: string;
        target: AutoInstallTarget;
        mode: AutoInstallPolicyView['mode'];
        scope?: AutoInstallPolicyView['scope'];
        applyToExisting?: boolean;
        enabled?: boolean;
        createdBy: string;
      },
      audit?: AuditContext,
    ): Promise<AutoInstallPolicyView> {
      const target = autoInstallTargetSchema.parse(input.target);
      return mutate(ctx, async (tx, unit) => {
        const entry = await tx.catalogEntry.findUnique({ where: { id: input.catalogEntryId } });
        if (!entry) throw new NotFoundError('catalog entry', input.catalogEntryId);
        if (entry.status !== 'published') {
          throw new ValidationError('auto-install needs a published catalog entry');
        }
        const row = await tx.autoInstallPolicy.create({
          data: {
            id: input.id ?? newId(),
            catalogEntryId: input.catalogEntryId,
            target: toJson(target),
            mode: input.mode,
            scope: input.scope ?? 'user',
            applyToExisting: input.applyToExisting ?? true,
            enabled: input.enabled ?? true,
            createdBy: input.createdBy,
          },
        });
        unit.bump('org');
        unit.audit(audit, {
          action: 'auto_install.create',
          targetType: 'auto_install_policy',
          targetId: row.id,
          diff: {
            before: null,
            after: { catalogEntryId: row.catalogEntryId, mode: row.mode, target },
          },
        });
        return toPolicyView(row);
      });
    },

    async update(
      id: string,
      patch: Partial<{
        target: AutoInstallTarget;
        mode: AutoInstallPolicyView['mode'];
        scope: AutoInstallPolicyView['scope'];
        applyToExisting: boolean;
        enabled: boolean;
      }>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<AutoInstallPolicyView> {
      const target =
        patch.target === undefined ? undefined : autoInstallTargetSchema.parse(patch.target);
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'auto-install policy',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.autoInstallPolicy.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { target: _t, ...rest } = patch;
            return tx.autoInstallPolicy.updateMany({
              where,
              data: {
                ...rest,
                ...(target === undefined ? {} : { target: toJson(target) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.autoInstallPolicy.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'auto_install.update',
          targetType: 'auto_install_policy',
          targetId: id,
          diff: { before: toPolicyView(current), after: toPolicyView(row) },
        });
        return toPolicyView(row);
      });
    },

    /** Deleting a policy keeps its installations as ordinary ones (11.5); the ledger goes with it. */
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.autoInstallPolicy.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('auto-install policy', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(
          await tx.autoInstallPolicy.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'auto_install.delete',
          targetType: 'auto_install_policy',
          targetId: id,
          diff: { before: toPolicyView(current), after: null },
        });
      });
    },

    /**
     * Idempotent application: records `(policy, subjectType, subjectId)` first with `ON CONFLICT DO NOTHING`; only
     * the call that inserted the row runs `run`, in the same transaction. A removed `default` installation is
     * therefore never re-added, and concurrent triggers apply once.
     */
    applyOnce(
      key: { policyId: string; subjectType: 'user' | 'team'; subjectId: string },
      run: (ctx: RepoContext) => Promise<{ installationId: string | null; result: string }>,
    ): Promise<ApplyOnceResult> {
      return mutate(ctx, async (tx, unit) => {
        const inserted = await tx.autoInstallApplication.createMany({
          data: [
            {
              policyId: key.policyId,
              subjectType: key.subjectType,
              subjectId: key.subjectId,
              result: 'pending',
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          const existing = await tx.autoInstallApplication.findUniqueOrThrow({
            where: {
              policyId_subjectType_subjectId: {
                policyId: key.policyId,
                subjectType: key.subjectType,
                subjectId: key.subjectId,
              },
            },
          });
          return {
            applied: false,
            installationId: existing.installationId,
            result: existing.result,
          };
        }
        const outcome = await run({ ...ctx, db: tx, unit });
        await tx.autoInstallApplication.update({
          where: {
            policyId_subjectType_subjectId: {
              policyId: key.policyId,
              subjectType: key.subjectType,
              subjectId: key.subjectId,
            },
          },
          data: { installationId: outcome.installationId, result: outcome.result },
        });
        return { applied: true, installationId: outcome.installationId, result: outcome.result };
      });
    },

    async listApplications(
      policyId: string,
      filter: { subjectType?: 'user' | 'team' } = {},
    ): Promise<AutoInstallApplicationView[]> {
      const rows = await db.autoInstallApplication.findMany({
        where: { policyId, ...(filter.subjectType ? { subjectType: filter.subjectType } : {}) },
        orderBy: { appliedAt: 'asc' },
      });
      return rows.map((r) => ({ ...r, subjectType: subjectTypeSchema.parse(r.subjectType) }));
    },

    /**
     * Active users the policy targets, in id order, for the 500-user fan-out jobs; `onlyUnapplied` skips users with
     * a ledger row.
     */
    async listTargetUsers(
      policyId: string,
      opts: { afterId?: string; limit: number; onlyUnapplied?: boolean },
    ): Promise<string[]> {
      const policy = await db.autoInstallPolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new NotFoundError('auto-install policy', policyId);
      const target = autoInstallTargetSchema.parse(policy.target);
      const out: string[] = [];
      const pageSize = Math.max(opts.limit, MIN_TARGET_PAGE_SIZE);
      let after = opts.afterId;
      while (out.length < opts.limit) {
        const batch = await db.user.findMany({
          where: {
            status: 'active',
            AND: [targetWhere(target), ...(after ? [{ id: { gt: after } }] : [])],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: pageSize,
        });
        if (batch.length === 0) break;
        const applied = opts.onlyUnapplied
          ? new Set(
              (
                await db.autoInstallApplication.findMany({
                  where: {
                    policyId,
                    subjectType: 'user',
                    subjectId: { in: batch.map((r) => r.id) },
                  },
                  select: { subjectId: true },
                })
              ).map((r) => r.subjectId),
            )
          : new Set<string>();
        for (const r of batch) {
          if (!applied.has(r.id)) out.push(r.id);
          if (out.length === opts.limit) break;
        }
        after = batch.at(-1)?.id;
        if (batch.length < pageSize) break;
      }
      return out;
    },

    /** Teams a `team`-scope policy targets: the listed teams, or every team for `all` (11.5). */
    async listTargetTeams(policyId: string): Promise<string[]> {
      const policy = await db.autoInstallPolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new NotFoundError('auto-install policy', policyId);
      const target = autoInstallTargetSchema.parse(policy.target);
      const rows = await db.team.findMany({
        where: target.all
          ? {}
          : {
              OR: [
                ...(target.teamIds?.length ? [{ id: { in: target.teamIds } }] : []),
                ...(target.idpGroups?.length ? [{ idpGroup: { in: target.idpGroups } }] : []),
              ],
            },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => r.id);
    },

    /** Enabled policies that may apply to a newly provisioned user (JIT, SCIM, team join). */
    async listEnabledForUserScope(): Promise<AutoInstallPolicyView[]> {
      const rows = await db.autoInstallPolicy.findMany({
        where: { enabled: true, scope: 'user', catalogEntry: { status: 'published' } },
        orderBy: { id: 'asc' },
      });
      return rows.map(toPolicyView);
    },
  };
};

import { DRIFT_POLICIES, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import type { GuardProfile } from '../generated/client';
import { createOrgSettingsRepository } from './org';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  ConflictError,
  etagOf,
  mutate,
  NotFoundError,
  orConflict,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  versionedUpdate,
  versionGuard,
} from './support';

// --- guard_profiles (13.1) --------------------------------------------------------------------------------------------------------

const guardInstancesSchema = z.array(
  z.looseObject({ instanceId: z.string().min(1), type: z.string().min(1) }),
);
const guardSettingsSchema = z.looseObject({
  maxScanBytes: z.number().int().min(1).optional(),
  onOversize: z.enum(['scanPrefix', 'block']).optional(),
  onDrift: z.enum(DRIFT_POLICIES).optional(),
  riskEscalation: z.looseObject({}).optional(),
});

export type GuardProfileView = {
  id: string;
  name: string;
  isOrgDefault: boolean;
  latencyBudgetMs: number;
  guards: z.infer<typeof guardInstancesSchema>;
  settings: z.infer<typeof guardSettingsSchema>;
  createdAt: Date;
  updatedAt: Date | null;
};

const toProfile = (r: GuardProfile): GuardProfileView => ({
  id: r.id,
  name: r.name,
  isOrgDefault: r.isOrgDefault,
  latencyBudgetMs: r.latencyBudgetMs,
  guards: guardInstancesSchema.parse(r.guards),
  settings: guardSettingsSchema.parse(r.settings),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The object `guardProfileSchema.parse` of `@bastion-mcp/guards` accepts for a stored profile. */
export const toPipelineProfile = (p: GuardProfileView): Record<string, unknown> => ({
  profileId: p.id,
  guards: p.guards,
  latencyBudgetMs: p.latencyBudgetMs,
  ...p.settings,
});

export type GuardProfileInput = {
  id?: string;
  name: string;
  latencyBudgetMs?: number;
  guards: unknown[];
  settings?: Record<string, unknown>;
};

/** `guard_profiles` CRUD with a single org default, mirrored into `settings.guards.orgDefaultProfileId`. */
export const createGuardProfileRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<GuardProfileView | null> {
      const row = await db.guardProfile.findUnique({ where: { id } });
      return row ? toProfile(row) : null;
    },
    async getWithEtag(id: string): Promise<{ profile: GuardProfileView; etag: string } | null> {
      const row = await db.guardProfile.findUnique({ where: { id } });
      return row ? { profile: toProfile(row), etag: etagOf(row) } : null;
    },
    async getOrgDefault(): Promise<GuardProfileView | null> {
      const row = await db.guardProfile.findFirst({ where: { isOrgDefault: true } });
      return row ? toProfile(row) : null;
    },
    async list(): Promise<GuardProfileView[]> {
      return (await db.guardProfile.findMany({ orderBy: { name: 'asc' } })).map(toProfile);
    },
    async create(input: GuardProfileInput, audit?: AuditContext): Promise<GuardProfileView> {
      const guards = guardInstancesSchema.parse(input.guards);
      const settings = guardSettingsSchema.parse(input.settings ?? {});
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('guard profile', () =>
          tx.guardProfile.create({
            data: {
              id: input.id ?? newId(),
              name: input.name,
              latencyBudgetMs: input.latencyBudgetMs ?? 1500,
              guards: toJson(guards),
              settings: toJson(settings),
            },
          }),
        );
        unit.bump('org');
        unit.audit(audit, {
          action: 'guard_profile.create',
          targetType: 'guard_profile',
          targetId: row.id,
          diff: { before: null, after: { name: row.name, guards: guards.length } },
        });
        return toProfile(row);
      });
    },
    async update(
      id: string,
      patch: Partial<Omit<GuardProfileInput, 'id'>>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<GuardProfileView> {
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'guard profile',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.guardProfile.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { guards, settings, ...rest } = patch;
            return orConflict('guard profile', () =>
              tx.guardProfile.updateMany({
                where,
                data: {
                  ...rest,
                  ...(guards === undefined
                    ? {}
                    : { guards: toJson(guardInstancesSchema.parse(guards)) }),
                  ...(settings === undefined
                    ? {}
                    : { settings: toJson(guardSettingsSchema.parse(settings)) }),
                  updatedAt,
                },
              }),
            );
          },
          reload: () => tx.guardProfile.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'guard_profile.update',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: toProfile(current), after: toProfile(row) },
        });
        return toProfile(row);
      });
    },
    /** Makes one profile the org default (clears the flag elsewhere) and mirrors it into org settings. */
    setOrgDefault(id: string | null, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        if (id !== null && (await tx.guardProfile.count({ where: { id } })) === 0) {
          throw new NotFoundError('guard profile', id);
        }
        await tx.guardProfile.updateMany({
          where: { isOrgDefault: true, ...(id === null ? {} : { NOT: { id } }) },
          data: { isOrgDefault: false },
        });
        if (id !== null)
          await tx.guardProfile.update({ where: { id }, data: { isOrgDefault: true } });
        await createOrgSettingsRepository({ ...ctx, db: tx, unit }).set(
          'guards',
          { orgDefaultProfileId: id },
          {},
        );
        unit.audit(audit, {
          action: 'guard_profile.set_default',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: null, after: { orgDefaultProfileId: id } },
        });
      });
    },
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.guardProfile.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('guard profile', id);
        assertIfMatch(current, opts.ifMatch);
        if (current.isOrgDefault)
          throw new ConflictError('the org default profile cannot be deleted', { id });
        const used = await tx.catalogVersion.count({ where: { guardProfileId: id } });
        if (used > 0)
          throw new ConflictError('guard profile is used by catalog versions', { used });
        assertSwapped(
          await tx.guardProfile.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'guard_profile.delete',
          targetType: 'guard_profile',
          targetId: id,
          diff: { before: { name: current.name }, after: null },
        });
      });
    },
  };
};

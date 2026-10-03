import { isValidSlug, MEMBERSHIP_SOURCES, newId, ORG_ROLES, TEAM_ROLES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { RoleMappingRule, Team } from '../generated/client';
import {
  afterKey,
  assertIfMatch,
  assertSwapped,
  compact,
  etagOf,
  mutate,
  NotFoundError,
  orConflict,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  ValidationError,
  versionedUpdate,
  versionGuard,
} from './support';
import type { IfMatchOptions, WriteOptions } from './users';

export type TeamRole = (typeof TEAM_ROLES)[number];
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

export type TeamView = {
  id: string;
  slug: string;
  displayName: string;
  idpGroup: string | null;
  createdAt: Date;
  updatedAt: Date | null;
};

const toTeamView = (row: Team): TeamView => ({
  id: row.id,
  slug: row.slug,
  displayName: row.displayName,
  idpGroup: row.idpGroup,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type MembershipView = {
  teamId: string;
  userId: string;
  role: TeamRole;
  source: MembershipSource;
  createdAt: Date;
};

const teamRole = z.enum(TEAM_ROLES);
const membershipSource = z.enum(MEMBERSHIP_SOURCES);

export type CreateTeamInput = {
  id?: string;
  slug: string;
  displayName: string;
  idpGroup?: string | null;
};

/** `teams` and `team_memberships` for the control plane (17.2). */
export const createTeamRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  return {
    async get(id: string): Promise<TeamView | null> {
      const row = await db.team.findUnique({ where: { id } });
      return row ? toTeamView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ team: TeamView; etag: string } | null> {
      const row = await db.team.findUnique({ where: { id } });
      return row ? { team: toTeamView(row), etag: etagOf(row) } : null;
    },
    async getBySlug(slug: string): Promise<TeamView | null> {
      const row = await db.team.findUnique({ where: { slug } });
      return row ? toTeamView(row) : null;
    },

    /** Teams ordered by slug; `userId` restricts to the teams the user belongs to. */
    async list(
      filter: { q?: string; userId?: string; limit?: number; cursor?: string } = {},
    ): Promise<Paged<TeamView>> {
      const q = filter.q?.trim();
      return paginate(
        filter,
        (take) =>
          db.team.findMany({
            where: {
              ...(filter.userId ? { teamMemberships: { some: { userId: filter.userId } } } : {}),
              ...(q
                ? {
                    OR: [
                      { slug: { contains: q, mode: 'insensitive' } },
                      { displayName: { contains: q, mode: 'insensitive' } },
                    ],
                  }
                : {}),
              ...afterKey('slug', 'asc', filter.cursor),
            },
            orderBy: { slug: 'asc' },
            take,
          }),
        (r) => [r.slug],
        toTeamView,
      );
    },

    async create(input: CreateTeamInput, opts: WriteOptions = {}): Promise<TeamView> {
      if (!isValidSlug(input.slug)) {
        throw new ValidationError('invalid team slug', { slug: input.slug });
      }
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('team', () =>
          tx.team.create({
            data: {
              id: input.id ?? newId(),
              slug: input.slug,
              displayName: input.displayName,
              idpGroup: input.idpGroup ?? null,
            },
          }),
        );
        unit.bump('team', row.id);
        unit.audit(opts.audit, {
          action: 'team.create',
          targetType: 'team',
          targetId: row.id,
          diff: { before: null, after: { slug: row.slug, displayName: row.displayName } },
        });
        return toTeamView(row);
      });
    },

    update(
      id: string,
      patch: { displayName?: string; idpGroup?: string | null },
      opts: IfMatchOptions,
    ): Promise<TeamView> {
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'team',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.team.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            return tx.team.updateMany({
              where,
              data: { ...patch, updatedAt },
            });
          },
          reload: () => tx.team.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('team', id);
        unit.audit(opts.audit, {
          action: 'team.update',
          targetType: 'team',
          targetId: id,
          diff: {
            before: { displayName: current.displayName, idpGroup: current.idpGroup },
            after: { displayName: row.displayName, idpGroup: row.idpGroup },
          },
        });
        return toTeamView(row);
      });
    },

    delete(id: string, opts: IfMatchOptions): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.team.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('team', id);
        assertIfMatch(current, opts.ifMatch);
        const members = await tx.teamMembership.findMany({
          where: { teamId: id },
          select: { userId: true },
        });
        assertSwapped(await tx.team.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('team', id);
        for (const m of members) unit.bump('user', m.userId);
        unit.audit(opts.audit, {
          action: 'team.delete',
          targetType: 'team',
          targetId: id,
          diff: { before: { slug: current.slug }, after: null },
        });
      });
    },

    // --- memberships -------------------------------------------------------------------------------

    async listMembers(
      teamId: string,
      filter: { source?: MembershipSource; role?: TeamRole } = {},
    ): Promise<MembershipView[]> {
      const rows = await db.teamMembership.findMany({
        where: {
          teamId,
          ...(filter.source ? { source: filter.source } : {}),
          ...(filter.role ? { role: filter.role } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      });
      return rows.map((r) => ({
        teamId: r.teamId,
        userId: r.userId,
        role: teamRole.parse(r.role),
        source: membershipSource.parse(r.source),
        createdAt: r.createdAt,
      }));
    },

    async listForUser(userId: string): Promise<MembershipView[]> {
      const rows = await db.teamMembership.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({
        teamId: r.teamId,
        userId: r.userId,
        role: teamRole.parse(r.role),
        source: membershipSource.parse(r.source),
        createdAt: r.createdAt,
      }));
    },

    /** Adds or changes a membership. A `manual` call replaces any source (admin decision, 9.1). */
    setMembership(
      input: { teamId: string; userId: string; role: TeamRole; source?: MembershipSource },
      opts: WriteOptions = {},
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const source = input.source ?? 'manual';
        const existing = await tx.teamMembership.findUnique({
          where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
        });
        await tx.teamMembership.upsert({
          where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
          create: { teamId: input.teamId, userId: input.userId, role: input.role, source },
          update: { role: input.role, source },
        });
        unit.bump('team', input.teamId);
        unit.bump('user', input.userId);
        unit.audit(opts.audit, {
          action: existing ? 'team.member.update' : 'team.member.add',
          targetType: 'team',
          targetId: input.teamId,
          diff: {
            before: existing ? { role: existing.role, source: existing.source } : null,
            after: { userId: input.userId, role: input.role, source },
          },
        });
      });
    },

    removeMembership(teamId: string, userId: string, opts: WriteOptions = {}): Promise<boolean> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.teamMembership.deleteMany({ where: { teamId, userId } });
        if (res.count === 0) return false;
        unit.bump('team', teamId);
        unit.bump('user', userId);
        unit.audit(opts.audit, {
          action: 'team.member.remove',
          targetType: 'team',
          targetId: teamId,
          diff: { before: { userId }, after: null },
        });
        return true;
      });
    },
  };
};

// --- role_mapping_rules ---------------------------------------------------------------------------------------

/** `maps_to` documents of 9.1: an org role, a team plus role, or "create the team from the group". */
export const mapsToSchema = z.union([
  z.object({ orgRole: z.enum(ORG_ROLES) }).strict(),
  z.object({ teamId: z.string().uuid(), teamRole: z.enum(TEAM_ROLES) }).strict(),
  z.object({ createTeam: z.literal(true), teamRole: z.enum(TEAM_ROLES).optional() }).strict(),
]);
export type MapsTo =
  | { orgRole: (typeof ORG_ROLES)[number] }
  | { teamId: string; teamRole: TeamRole }
  | { createTeam: true; teamRole?: TeamRole };

/** Validates a stored or submitted `maps_to` document. */
export const parseMapsTo = (raw: unknown): MapsTo => compact<MapsTo>(mapsToSchema.parse(raw));

/** The `RoleMappingRule` of `@bastion-mcp/auth` provisioning. */
export type RoleMappingRuleView = {
  id: string;
  idpConnectionId: string | null;
  groupPattern: string;
  mapsTo: MapsTo;
  priority: number;
};

const toRuleView = (row: RoleMappingRule): RoleMappingRuleView => ({
  id: row.id,
  idpConnectionId: row.idpConnectionId,
  groupPattern: row.groupPattern,
  mapsTo: parseMapsTo(row.mapsTo),
  priority: row.priority,
});

export type RoleMappingRuleInput = {
  id?: string;
  idpConnectionId?: string | null;
  groupPattern: string;
  mapsTo: MapsTo;
  priority?: number;
};

export const createRoleMappingRuleRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    /** Rules of one connection plus the global ones (null connection), by priority. */
    async list(connectionId?: string | null): Promise<RoleMappingRuleView[]> {
      const rows = await db.roleMappingRule.findMany({
        where:
          connectionId === undefined
            ? {}
            : connectionId === null
              ? { idpConnectionId: null }
              : { OR: [{ idpConnectionId: connectionId }, { idpConnectionId: null }] },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toRuleView);
    },
    async get(id: string): Promise<RoleMappingRuleView | null> {
      const row = await db.roleMappingRule.findUnique({ where: { id } });
      return row ? toRuleView(row) : null;
    },
    async create(
      input: RoleMappingRuleInput,
      opts: WriteOptions = {},
    ): Promise<RoleMappingRuleView> {
      const mapsTo = parseMapsTo(input.mapsTo);
      return mutate(ctx, async (tx, unit) => {
        const row = await tx.roleMappingRule.create({
          data: {
            id: input.id ?? newId(),
            idpConnectionId: input.idpConnectionId ?? null,
            groupPattern: input.groupPattern,
            mapsTo: toJson(mapsTo),
            priority: input.priority ?? 100,
          },
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'role_mapping_rule.create',
          targetType: 'role_mapping_rule',
          targetId: row.id,
          diff: { before: null, after: { groupPattern: row.groupPattern, mapsTo } },
        });
        return toRuleView(row);
      });
    },
    async update(
      id: string,
      patch: { groupPattern?: string; mapsTo?: MapsTo; priority?: number },
      opts: IfMatchOptions,
    ): Promise<RoleMappingRuleView> {
      const mapsTo = patch.mapsTo === undefined ? undefined : parseMapsTo(patch.mapsTo);
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'role mapping rule',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.roleMappingRule.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            return tx.roleMappingRule.updateMany({
              where,
              data: {
                ...(patch.groupPattern === undefined ? {} : { groupPattern: patch.groupPattern }),
                ...(patch.priority === undefined ? {} : { priority: patch.priority }),
                ...(mapsTo === undefined ? {} : { mapsTo: toJson(mapsTo) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.roleMappingRule.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'role_mapping_rule.update',
          targetType: 'role_mapping_rule',
          targetId: id,
          diff: { before: toRuleView(current), after: toRuleView(row) },
        });
        return toRuleView(row);
      });
    },
    delete(id: string, opts: IfMatchOptions): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.roleMappingRule.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('role mapping rule', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(
          await tx.roleMappingRule.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'role_mapping_rule.delete',
          targetType: 'role_mapping_rule',
          targetId: id,
          diff: { before: { groupPattern: current.groupPattern }, after: null },
        });
      });
    },
    etagOf,
  };
};

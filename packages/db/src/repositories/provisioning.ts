import { MEMBERSHIP_SOURCES, ORG_ROLES, TEAM_ROLES, USER_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { Prisma } from '../generated/client';
import type { AuditContext } from './support';
import {
  ConflictError,
  isUniqueViolation,
  mutate,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  type Tx,
  toContext,
  type UnitState,
} from './support';
import { type MapsTo, parseMapsTo } from './teams';

type OrgRole = (typeof ORG_ROLES)[number];
type TeamRole = (typeof TEAM_ROLES)[number];
type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];
type UserStatus = (typeof USER_STATUSES)[number];

const orgRole = z.enum(ORG_ROLES);
const teamRole = z.enum(TEAM_ROLES);
const membershipSource = z.enum(MEMBERSHIP_SOURCES);
const userStatus = z.enum(USER_STATUSES);

// --- shapes copied from @bastion-mcp/auth (db may not import it; apps/server checks assignability) -----------

/** `MembershipState` of `auth/identity/provisioning/plan.ts`. */
export type MembershipState = { teamId: string; role: TeamRole; source: MembershipSource };

/** `UserState` of `auth/identity/provisioning/plan.ts`. */
export type UserState = {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
  status: 'active' | 'deactivated';
  idpConnectionId: string | null;
  externalSubject: string | null;
  isLocal: boolean;
  memberships: readonly MembershipState[];
};

export type UserChange =
  | {
      kind: 'create';
      id: string;
      email: string;
      displayName: string;
      orgRole: OrgRole;
      idpConnectionId: string | null;
      externalSubject: string | null;
      status?: UserStatus;
      scimExternalId?: string | null;
    }
  | {
      kind: 'update';
      id: string;
      changes: {
        displayName?: string;
        email?: string;
        scimExternalId?: string | null;
        orgRole?: OrgRole;
        externalSubject?: string;
        idpConnectionId?: string;
        status?: UserStatus;
        lastLoginAt?: Date;
      };
    }
  | { kind: 'none'; id: string };

export type NewTeam = { id: string; slug: string; displayName: string; idpGroup: string };

/** `ProvisioningPlan` of `auth/identity/provisioning/plan.ts` (events are handed to `onApplied`). */
export type ProvisioningPlan = {
  user: UserChange;
  createTeams: NewTeam[];
  membershipUpserts: { teamId: string; userId: string; role: TeamRole; source: MembershipSource }[];
  membershipRemovals: { teamId: string; userId: string }[];
  events: { type: string; userId: string; [key: string]: unknown }[];
  warnings: string[];
};

export type ProvisioningOptions = {
  /** Runs after the plan's transaction commits (auto-install policies, 11.5). */
  onApplied?: (plan: ProvisioningPlan) => void | Promise<void>;
  /** Builds the error thrown when a plan violates a unique constraint (SCIM: `ScimStoreConflictError`). */
  conflictError?: (message: string) => Error;
  audit?: AuditContext;
};

const applyOne = async (
  tx: Tx,
  unit: UnitState,
  plan: ProvisioningPlan,
  audit: AuditContext | undefined,
): Promise<void> => {
  for (const team of plan.createTeams) {
    await tx.team.create({
      data: {
        id: team.id,
        slug: team.slug,
        displayName: team.displayName,
        idpGroup: team.idpGroup,
      },
    });
    unit.bump('team', team.id);
    unit.audit(audit, {
      action: 'team.create',
      targetType: 'team',
      targetId: team.id,
      diff: { before: null, after: { slug: team.slug, idpGroup: team.idpGroup } },
    });
  }

  const change = plan.user;
  if (change.kind === 'create') {
    await tx.user.create({
      data: {
        id: change.id,
        email: change.email,
        displayName: change.displayName,
        orgRole: change.orgRole,
        idpConnectionId: change.idpConnectionId,
        externalSubject: change.externalSubject,
        scimExternalId: change.scimExternalId ?? null,
        status: change.status ?? 'active',
      },
    });
    unit.bump('user', change.id);
    unit.audit(audit, {
      action: 'user.provision',
      targetType: 'user',
      targetId: change.id,
      diff: { before: null, after: { email: change.email, orgRole: change.orgRole } },
    });
  } else if (change.kind === 'update') {
    const { changes } = change;
    const data: Prisma.UserUncheckedUpdateManyInput = {
      ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
      ...(changes.email === undefined ? {} : { email: changes.email }),
      ...(changes.scimExternalId === undefined ? {} : { scimExternalId: changes.scimExternalId }),
      ...(changes.orgRole === undefined ? {} : { orgRole: changes.orgRole }),
      ...(changes.externalSubject === undefined
        ? {}
        : { externalSubject: changes.externalSubject }),
      ...(changes.idpConnectionId === undefined
        ? {}
        : { idpConnectionId: changes.idpConnectionId }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      ...(changes.lastLoginAt === undefined ? {} : { lastLoginAt: changes.lastLoginAt }),
    };
    const configChanged = Object.keys(changes).some((k) => k !== 'lastLoginAt');
    if (Object.keys(data).length > 0) {
      const res = await tx.user.updateMany({
        where: { id: change.id },
        data: configChanged ? { ...data, updatedAt: new Date() } : data,
      });
      if (res.count !== 1) throw new ConflictError('user to update does not exist');
    }
    if (configChanged) {
      unit.bump('user', change.id);
      unit.audit(audit, {
        action: changes.status === 'deactivated' ? 'user.deactivate' : 'user.update',
        targetType: 'user',
        targetId: change.id,
        diff: { before: null, after: { ...changes, lastLoginAt: undefined } },
      });
    }
  }

  for (const m of plan.membershipUpserts) {
    await tx.teamMembership.upsert({
      where: { teamId_userId: { teamId: m.teamId, userId: m.userId } },
      create: { teamId: m.teamId, userId: m.userId, role: m.role, source: m.source },
      update: { role: m.role, source: m.source },
    });
    unit.bump('team', m.teamId);
    unit.bump('user', m.userId);
    unit.audit(audit, {
      action: 'team.member.set',
      targetType: 'team',
      targetId: m.teamId,
      diff: { before: null, after: { userId: m.userId, role: m.role, source: m.source } },
    });
  }
  for (const m of plan.membershipRemovals) {
    const res = await tx.teamMembership.deleteMany({
      where: { teamId: m.teamId, userId: m.userId },
    });
    if (res.count > 0) {
      unit.bump('team', m.teamId);
      unit.bump('user', m.userId);
      unit.audit(audit, {
        action: 'team.member.remove',
        targetType: 'team',
        targetId: m.teamId,
        diff: { before: { userId: m.userId }, after: null },
      });
    }
  }
};

/**
 * `ProvisioningRepository.applyPlan` (9.1): one transaction for `createTeams`, the user change, then
 * memberships. Config versions of every touched user and team are bumped in the same transaction.
 */
export const createProvisioningRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions & ProvisioningOptions,
) => {
  const ctx = toContext(arg, options);
  const conflict = options?.conflictError ?? ((m: string) => new ConflictError(m));
  const applyPlans = async (
    plans: readonly ProvisioningPlan[],
    audit: AuditContext | undefined = options?.audit,
  ): Promise<void> => {
    try {
      await mutate(ctx, async (tx, unit) => {
        for (const plan of plans) await applyOne(tx, unit, plan, audit);
        if (options?.onApplied) {
          const hook = options.onApplied;
          for (const plan of plans) unit.afterCommit.push(() => hook(plan));
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('email or team slug already exists');
      throw error;
    }
  };
  return {
    applyPlan: (plan: ProvisioningPlan, audit?: AuditContext): Promise<void> =>
      applyPlans([plan], audit),
    applyPlans,
  };
};

// --- PrincipalStore and directories -----------------------------------------------------------------------------

export type PrincipalRecord = {
  id: string;
  type: 'user' | 'service';
  orgRole: OrgRole;
  teams: readonly { teamId: string; role: TeamRole }[];
  active: boolean;
};

/**
 * `PrincipalStore` (auth identity), the oauth `PrincipalDirectory` and the policy `PrincipalDirectory`.
 * A service account is a `member` of its team, never a manager (10.1).
 */
export const createPrincipalRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    async getPrincipal(id: string): Promise<PrincipalRecord | null> {
      const user = await db.user.findUnique({
        where: { id },
        include: { teamMemberships: { select: { teamId: true, role: true } } },
      });
      if (user) {
        return {
          id: user.id,
          type: 'user',
          orgRole: orgRole.parse(user.orgRole),
          teams: user.teamMemberships.map((m) => ({
            teamId: m.teamId,
            role: teamRole.parse(m.role),
          })),
          active: user.status === 'active',
        };
      }
      const sa = await db.serviceAccount.findUnique({ where: { id } });
      if (!sa) return null;
      return {
        id: sa.id,
        type: 'service',
        orgRole: 'member',
        teams: [{ teamId: sa.teamId, role: 'member' }],
        active: sa.status === 'active',
      };
    },

    /** oauth `PrincipalDirectory.isUserActive`. */
    async isUserActive(userId: string): Promise<boolean> {
      const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
      return user?.status === 'active';
    },

    /** oauth `PrincipalDirectory.serviceAccountForClient`; disabled accounts get no token. */
    async serviceAccountForClient(clientId: string): Promise<{ id: string } | null> {
      const sa = await db.serviceAccount.findUnique({ where: { oauthClientId: clientId } });
      return sa && sa.status === 'active' ? { id: sa.id } : null;
    },

    /** policy `PrincipalDirectory.find` returning a `PrincipalInput`. */
    async find(ref: { kind: 'user' | 'service'; id: string }) {
      if (ref.kind === 'user') {
        const user = await db.user.findUnique({
          where: { id: ref.id },
          include: { teamMemberships: { include: { team: { select: { slug: true } } } } },
        });
        if (!user) return null;
        return {
          kind: 'user' as const,
          id: user.id,
          role: orgRole.parse(user.orgRole),
          active: user.status === 'active',
          emailDomain: user.email.split('@')[1]?.toLowerCase() ?? '',
          teams: user.teamMemberships.map((m) => ({
            id: m.teamId,
            slug: m.team.slug,
            role: teamRole.parse(m.role),
          })),
        };
      }
      const sa = await db.serviceAccount.findUnique({
        where: { id: ref.id },
        include: { team: { select: { slug: true } } },
      });
      if (!sa) return null;
      return {
        kind: 'service' as const,
        id: sa.id,
        active: sa.status === 'active',
        team: { id: sa.teamId, slug: sa.team.slug },
      };
    },
  };
};

// --- SCIM store --------------------------------------------------------------------------------------------------

export type ScimFilterValue = string | number | boolean | null;
/** `FilterNode` of `auth/identity/scim/filter.ts`. */
export type ScimFilterNode =
  | { op: 'and' | 'or'; left: ScimFilterNode; right: ScimFilterNode }
  | { op: 'not'; operand: ScimFilterNode }
  | { op: 'eq' | 'ne' | 'co' | 'sw' | 'ew'; attr: string; value: ScimFilterValue }
  | { op: 'pr'; attr: string };

export type ScimListQuery = { filter: ScimFilterNode | null; startIndex: number; count: number };

export type ScimUserRecord = {
  id: string;
  userName: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date | null;
};

export type ScimGroupRecord = {
  id: string;
  displayName: string;
  members: { id: string; display: string }[];
  createdAt: Date;
  updatedAt: Date | null;
};

export type TeamRef = { id: string; slug: string; idpGroup: string | null };

export type ScimRoleRule = {
  id: string;
  idpConnectionId: string | null;
  groupPattern: string;
  mapsTo: MapsTo;
  priority: number;
};

type AttrKind = 'string' | 'bool';

/** SCIM attributes the store can filter on; others never match (RFC 7644 3.4.2.2: unknown attributes). */
const userAttrs: Record<string, { column: string; kind: AttrKind }> = {
  username: { column: 'email', kind: 'string' },
  'emails.value': { column: 'email', kind: 'string' },
  displayname: { column: 'displayName', kind: 'string' },
  externalid: { column: 'scimExternalId', kind: 'string' },
  id: { column: 'id', kind: 'string' },
  active: { column: 'status', kind: 'bool' },
};
const groupAttrs: Record<string, { column: string; kind: AttrKind }> = {
  displayname: { column: 'displayName', kind: 'string' },
  id: { column: 'id', kind: 'string' },
};

const NEVER = { id: { in: [] as string[] } };

const comparison = (
  attrs: Record<string, { column: string; kind: AttrKind }>,
  node: Extract<ScimFilterNode, { attr: string }>,
): Record<string, unknown> => {
  const spec = attrs[node.attr.toLowerCase()];
  if (!spec) return node.op === 'ne' ? {} : NEVER;
  const { column, kind } = spec;
  if (node.op === 'pr') {
    if (kind === 'bool') return {};
    return { AND: [{ [column]: { not: null } }, { NOT: { [column]: '' } }] };
  }
  if (kind === 'bool') {
    if (typeof node.value !== 'boolean') return NEVER;
    const active = node.op === 'eq' ? node.value : !node.value;
    return { [column]: active ? 'active' : { not: 'active' } };
  }
  const value = node.value === null ? '' : String(node.value);
  const insensitive = column !== 'id';
  const mode = insensitive ? { mode: 'insensitive' as const } : {};
  switch (node.op) {
    case 'eq':
      return column === 'id' ? { id: value } : { [column]: { equals: value, ...mode } };
    case 'ne':
      return { NOT: column === 'id' ? { id: value } : { [column]: { equals: value, ...mode } } };
    case 'co':
      return { [column]: { contains: value, ...mode } };
    case 'sw':
      return { [column]: { startsWith: value, ...mode } };
    case 'ew':
      return { [column]: { endsWith: value, ...mode } };
  }
};

/** Translates the supported SCIM filter subset to a Prisma `where`. */
export const scimFilterToWhere = (
  node: ScimFilterNode | null,
  attrs: Record<string, { column: string; kind: AttrKind }>,
): Record<string, unknown> => {
  if (!node) return {};
  switch (node.op) {
    case 'and':
      return { AND: [scimFilterToWhere(node.left, attrs), scimFilterToWhere(node.right, attrs)] };
    case 'or':
      return { OR: [scimFilterToWhere(node.left, attrs), scimFilterToWhere(node.right, attrs)] };
    case 'not':
      return { NOT: scimFilterToWhere(node.operand, attrs) };
    default:
      return comparison(attrs, node);
  }
};

/**
 * `ScimStore` (9.1). SCIM Groups are teams with an `idp_group`. `conflictError` builds the port's
 * `ScimStoreConflictError` (a class owned by `@bastion-mcp/auth`, injected by `apps/server`).
 */
export const createScimStore = (
  arg: PrismaLike | RepoContext,
  deps: { conflictError: (message: string) => Error; onApplied?: ProvisioningOptions['onApplied'] },
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const provisioning = createProvisioningRepository(ctx, {
    conflictError: deps.conflictError,
    ...(deps.onApplied ? { onApplied: deps.onApplied } : {}),
    audit: { actorType: 'scim' },
  });

  const userRecord = (u: {
    id: string;
    email: string;
    displayName: string;
    scimExternalId: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date | null;
  }): ScimUserRecord => ({
    id: u.id,
    userName: u.email,
    displayName: u.displayName,
    externalId: u.scimExternalId,
    active: u.status === 'active',
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  });

  const groupRecord = (t: {
    id: string;
    displayName: string;
    createdAt: Date;
    updatedAt: Date | null;
    teamMemberships: { user: { id: string; displayName: string } }[];
  }): ScimGroupRecord => ({
    id: t.id,
    displayName: t.displayName,
    members: t.teamMemberships.map((m) => ({ id: m.user.id, display: m.user.displayName })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });

  const scimMembers = {
    where: { source: 'scim' },
    select: { user: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: 'asc' },
  } as const;

  return {
    async listUsers(q: ScimListQuery): Promise<{ total: number; items: ScimUserRecord[] }> {
      const where = {
        AND: [{ localPasswordHash: null }, scimFilterToWhere(q.filter, userAttrs)],
      } as Prisma.UserWhereInput;
      const [total, rows] = await Promise.all([
        db.user.count({ where }),
        db.user.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: Math.max(0, q.startIndex - 1),
          take: q.count,
        }),
      ]);
      return { total, items: rows.map(userRecord) };
    },

    async getUser(id: string): Promise<ScimUserRecord | null> {
      const row = await db.user.findFirst({ where: { id, localPasswordHash: null } });
      return row ? userRecord(row) : null;
    },

    async getUserState(id: string): Promise<UserState | null> {
      const row = await db.user.findUnique({
        where: { id },
        include: { teamMemberships: true },
      });
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        orgRole: orgRole.parse(row.orgRole),
        status: userStatus.parse(row.status),
        idpConnectionId: row.idpConnectionId,
        externalSubject: row.externalSubject,
        isLocal: row.localPasswordHash !== null,
        memberships: row.teamMemberships.map((m) => ({
          teamId: m.teamId,
          role: teamRole.parse(m.role),
          source: membershipSource.parse(m.source),
        })),
      };
    },

    async findUserIdByEmail(email: string): Promise<string | null> {
      const row = await db.user.findUnique({ where: { email }, select: { id: true } });
      return row?.id ?? null;
    },

    async listGroups(q: ScimListQuery): Promise<{ total: number; items: ScimGroupRecord[] }> {
      const where = {
        AND: [{ idpGroup: { not: null } }, scimFilterToWhere(q.filter, groupAttrs)],
      } as Prisma.TeamWhereInput;
      const [total, rows] = await Promise.all([
        db.team.count({ where }),
        db.team.findMany({
          where,
          include: { teamMemberships: scimMembers },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: Math.max(0, q.startIndex - 1),
          take: q.count,
        }),
      ]);
      return { total, items: rows.map(groupRecord) };
    },

    async getGroup(id: string): Promise<ScimGroupRecord | null> {
      const row = await db.team.findFirst({
        where: { id, idpGroup: { not: null } },
        include: { teamMemberships: scimMembers },
      });
      return row ? groupRecord(row) : null;
    },

    async findGroupByName(displayName: string): Promise<ScimGroupRecord | null> {
      const row = await db.team.findFirst({
        where: { idpGroup: { not: null }, OR: [{ displayName }, { idpGroup: displayName }] },
        include: { teamMemberships: scimMembers },
      });
      return row ? groupRecord(row) : null;
    },

    async listTeamRefs(): Promise<TeamRef[]> {
      const rows = await db.team.findMany({
        select: { id: true, slug: true, idpGroup: true },
        orderBy: { slug: 'asc' },
      });
      return rows;
    },

    async userScimGroups(userId: string): Promise<{ teamId: string; name: string }[]> {
      const rows = await db.teamMembership.findMany({
        where: { userId, source: 'scim', team: { idpGroup: { not: null } } },
        select: { teamId: true, team: { select: { idpGroup: true } } },
      });
      return rows.map((r) => ({ teamId: r.teamId, name: r.team.idpGroup ?? '' }));
    },

    async listRules(connectionId: string | null): Promise<ScimRoleRule[]> {
      const rows = await db.roleMappingRule.findMany({
        where:
          connectionId === null
            ? { idpConnectionId: null }
            : { OR: [{ idpConnectionId: connectionId }, { idpConnectionId: null }] },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        idpConnectionId: r.idpConnectionId,
        groupPattern: r.groupPattern,
        mapsTo: parseMapsTo(r.mapsTo),
        priority: r.priority,
      }));
    },

    applyPlans: provisioning.applyPlans,

    async renameGroup(id: string, displayName: string): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const res = await tx.team.updateMany({
          where: { id, idpGroup: { not: null } },
          data: { displayName, idpGroup: displayName, updatedAt: new Date() },
        });
        if (res.count === 0) return;
        unit.bump('team', id);
        unit.audit(
          { actorType: 'scim' },
          {
            action: 'team.rename',
            targetType: 'team',
            targetId: id,
            diff: { before: null, after: { displayName } },
          },
        );
      });
    },

    async detachGroup(id: string): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const res = await tx.team.updateMany({
          where: { id, idpGroup: { not: null } },
          data: { idpGroup: null, updatedAt: new Date() },
        });
        if (res.count === 0) return;
        unit.bump('team', id);
        unit.audit(
          { actorType: 'scim' },
          {
            action: 'team.detach_group',
            targetType: 'team',
            targetId: id,
            diff: { before: { idpGroup: true }, after: { idpGroup: null } },
          },
        );
      });
    },
  };
};

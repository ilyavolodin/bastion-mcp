import { ProvisioningDeniedError } from '../errors';
import type { OrgRole, TeamRole } from '../principal';
import { externalSubjectFor, type IdentityClaims, type IdpConnection } from './claims';
import {
  type DesiredMembership,
  evaluateRules,
  type NewTeam,
  type RoleMappingRule,
  type TeamRef,
} from './rules';

export type MembershipSource = 'manual' | 'idp' | 'scim';

export type MembershipState = { teamId: string; role: TeamRole; source: MembershipSource };

/** A user as the repository sees it, with memberships, for planning. */
export type UserState = {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
  status: 'active' | 'deactivated';
  idpConnectionId: string | null;
  externalSubject: string | null;
  /** Break-glass local admin (has a local password hash); never linked to an IdP identity. */
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
      status?: 'active' | 'deactivated';
      /** SCIM `externalId`, kept by the adapter next to the user. */
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
        status?: 'active' | 'deactivated';
        lastLoginAt?: Date;
      };
    }
  | { kind: 'none'; id: string };

/** Events handed to the catalog layer, which runs auto-install policies (11.5). Not acted on here. */
export type ProvisioningEvent =
  | { type: 'user.created'; userId: string; email: string }
  | { type: 'user.role_changed'; userId: string; from: OrgRole; to: OrgRole }
  | { type: 'team.member_added'; userId: string; teamId: string; role: TeamRole }
  | { type: 'user.deactivated'; userId: string };

/**
 * Everything one login or SCIM update changes; the repository applies it in one transaction.
 * `createTeams` come first, then the user change, then memberships.
 */
export type ProvisioningPlan = {
  user: UserChange;
  createTeams: NewTeam[];
  membershipUpserts: { teamId: string; userId: string; role: TeamRole; source: MembershipSource }[];
  membershipRemovals: { teamId: string; userId: string }[];
  events: ProvisioningEvent[];
  warnings: string[];
};

/** Repository port that applies a plan atomically (implemented by `@bastion-mcp/db`). */
export interface ProvisioningRepository {
  applyPlan(plan: ProvisioningPlan): Promise<void>;
}

/**
 * Reconciles memberships of one `source` with the desired set: upserts new or changed ones, removes
 * those of that source that are no longer desired, and never overrides a membership from another source.
 */
export const reconcileMemberships = (input: {
  userId: string;
  source: MembershipSource;
  desired: readonly DesiredMembership[];
  current: readonly MembershipState[];
}): {
  upserts: ProvisioningPlan['membershipUpserts'];
  removals: ProvisioningPlan['membershipRemovals'];
  added: DesiredMembership[];
} => {
  const upserts: ProvisioningPlan['membershipUpserts'] = [];
  const added: DesiredMembership[] = [];
  for (const d of input.desired) {
    const cur = input.current.find((m) => m.teamId === d.teamId);
    if (cur && cur.source !== input.source) continue;
    if (cur?.role === d.role) continue;
    upserts.push({ teamId: d.teamId, userId: input.userId, role: d.role, source: input.source });
    if (!cur) added.push(d);
  }
  const wanted = new Set(input.desired.map((d) => d.teamId));
  const removals = input.current
    .filter((m) => m.source === input.source && !wanted.has(m.teamId))
    .map((m) => ({ teamId: m.teamId, userId: input.userId }));
  return { upserts, removals, added };
};

export type PlanLoginInput = {
  connection: IdpConnection;
  claims: IdentityClaims;
  /** The user matched by external subject, else by email; null for a first login. */
  existingUser: UserState | null;
  rules: readonly RoleMappingRule[];
  teams: readonly TeamRef[];
  now: Date;
  newId: () => string;
};

/**
 * Pure plan for an IdP login (9.1): JIT provisioning on first login, group mapping re-evaluated on every
 * login. Throws `ProvisioningDeniedError` for deactivated users and identity conflicts.
 */
export const planLogin = (input: PlanLoginInput): ProvisioningPlan => {
  const { connection, claims, existingUser: existing } = input;
  if (!connection.enabled) {
    throw new ProvisioningDeniedError('identity provider is disabled', 'idp_disabled');
  }
  const subject = externalSubjectFor(connection.issuer, claims.sub);
  const evaluation = evaluateRules({
    rules: input.rules,
    connectionId: connection.id,
    groups: claims.groups,
    existingTeams: input.teams,
    newId: input.newId,
  });
  const events: ProvisioningEvent[] = [];
  const base = {
    createTeams: evaluation.createTeams,
    warnings: evaluation.warnings,
  };

  if (!existing) {
    const id = input.newId();
    events.push({ type: 'user.created', userId: id, email: claims.email });
    const upserts = evaluation.memberships.map((m) => ({
      teamId: m.teamId,
      userId: id,
      role: m.role,
      source: 'idp' as const,
    }));
    for (const m of evaluation.memberships) {
      events.push({ type: 'team.member_added', userId: id, teamId: m.teamId, role: m.role });
    }
    return {
      ...base,
      user: {
        kind: 'create',
        id,
        email: claims.email,
        displayName: claims.displayName,
        orgRole: evaluation.orgRole ?? 'member',
        idpConnectionId: connection.id,
        externalSubject: subject,
      },
      membershipUpserts: upserts,
      membershipRemovals: [],
      events,
    };
  }

  if (existing.status === 'deactivated') {
    throw new ProvisioningDeniedError('user is deactivated', 'deactivated');
  }
  if (existing.isLocal) {
    throw new ProvisioningDeniedError('local accounts cannot be linked to an IdP', 'local_account');
  }
  if (existing.externalSubject !== null && existing.externalSubject !== subject) {
    throw new ProvisioningDeniedError('email belongs to a different identity', 'subject_conflict');
  }
  if (existing.idpConnectionId !== null && existing.idpConnectionId !== connection.id) {
    throw new ProvisioningDeniedError('user belongs to another identity provider', 'idp_conflict');
  }

  const changes: Extract<UserChange, { kind: 'update' }>['changes'] = { lastLoginAt: input.now };
  if (existing.displayName !== claims.displayName) changes.displayName = claims.displayName;
  if (existing.externalSubject === null) changes.externalSubject = subject;
  if (existing.idpConnectionId === null) changes.idpConnectionId = connection.id;
  if (evaluation.orgRoleManaged) {
    const role = evaluation.orgRole ?? 'member';
    if (role !== existing.orgRole) {
      changes.orgRole = role;
      events.push({
        type: 'user.role_changed',
        userId: existing.id,
        from: existing.orgRole,
        to: role,
      });
    }
  }
  const rec = reconcileMemberships({
    userId: existing.id,
    source: 'idp',
    desired: evaluation.memberships,
    current: existing.memberships,
  });
  for (const m of rec.added) {
    events.push({ type: 'team.member_added', userId: existing.id, teamId: m.teamId, role: m.role });
  }
  return {
    ...base,
    user: { kind: 'update', id: existing.id, changes },
    membershipUpserts: rec.upserts,
    membershipRemovals: rec.removals,
    events,
  };
};

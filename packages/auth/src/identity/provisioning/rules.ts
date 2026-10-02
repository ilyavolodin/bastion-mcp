import { isValidSlug, slugify } from '@bastion-mcp/core';
import RE2 from 're2';
import type { OrgRole, TeamRole } from '../principal';

export type MapsTo =
  | { orgRole: OrgRole }
  | { teamId: string; teamRole: TeamRole }
  | { createTeam: true; teamRole?: TeamRole };

/** A `role_mapping_rules` row (16.2). Lower `priority` is evaluated first. */
export type RoleMappingRule = {
  id: string;
  idpConnectionId: string | null;
  groupPattern: string;
  mapsTo: MapsTo;
  priority: number;
};

export type TeamRef = { id: string; slug: string; idpGroup: string | null };
export type NewTeam = { id: string; slug: string; displayName: string; idpGroup: string };
export type DesiredMembership = { teamId: string; role: TeamRole };

export type RuleEvaluation = {
  /** First matching org-role rule by priority; null when none matched. */
  orgRole: OrgRole | null;
  /** True when at least one applicable rule maps an org role, so the IdP owns the role. */
  orgRoleManaged: boolean;
  memberships: DesiredMembership[];
  createTeams: NewTeam[];
  warnings: string[];
};

const MAX_PATTERN_LENGTH = 256;

/**
 * Patterns run on RE2 (linear time, no backreferences or lookaround), so an admin-authored rule cannot
 * cause catastrophic backtracking; they are full-match anchored.
 */
const compile = (pattern: string): RE2 | null => {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return null;
  try {
    return new RE2(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
};

const strongerRole = (a: TeamRole, b: TeamRole): TeamRole =>
  a === 'manager' || b === 'manager' ? 'manager' : 'member';

export const evaluateRules = (input: {
  rules: readonly RoleMappingRule[];
  connectionId: string;
  groups: readonly string[];
  existingTeams: readonly TeamRef[];
  newId: () => string;
}): RuleEvaluation => {
  const warnings: string[] = [];
  const applicable = input.rules
    .filter((r) => r.idpConnectionId === null || r.idpConnectionId === input.connectionId)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const orgRoleManaged = applicable.some((r) => 'orgRole' in r.mapsTo);
  let orgRole: OrgRole | null = null;
  const desired = new Map<string, TeamRole>();
  const created = new Map<string, NewTeam>();
  const add = (teamId: string, role: TeamRole) =>
    desired.set(teamId, strongerRole(desired.get(teamId) ?? role, role));

  for (const rule of applicable) {
    const re = compile(rule.groupPattern);
    if (!re) {
      warnings.push(`rule ${rule.id}: unsupported or invalid pattern ignored`);
      continue;
    }
    const matched = input.groups.filter((g) => re.test(g));
    if (matched.length === 0) continue;
    const to = rule.mapsTo;
    if ('orgRole' in to) {
      orgRole ??= to.orgRole;
    } else if ('teamId' in to) {
      add(to.teamId, to.teamRole);
    } else {
      for (const group of matched) {
        const slug = slugify(group);
        if (!isValidSlug(slug)) {
          warnings.push(`group "${group}" cannot be turned into a team slug`);
          continue;
        }
        const existing =
          input.existingTeams.find((t) => t.idpGroup === group) ??
          input.existingTeams.find((t) => t.slug === slug && t.idpGroup === null);
        let team = existing ? { id: existing.id } : created.get(slug);
        if (!team) {
          const fresh = { id: input.newId(), slug, displayName: group, idpGroup: group };
          created.set(slug, fresh);
          team = fresh;
        }
        add(team.id, to.teamRole ?? 'member');
      }
    }
  }
  return {
    orgRole,
    orgRoleManaged,
    memberships: [...desired].map(([teamId, role]) => ({ teamId, role })),
    createTeams: [...created.values()],
    warnings,
  };
};

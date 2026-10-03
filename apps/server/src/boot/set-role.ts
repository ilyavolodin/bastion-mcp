import { ORG_ROLES } from '@bastion-mcp/core';
import type { Infra } from '../infra';

type OrgRole = (typeof ORG_ROLES)[number];

export type SetRoleResult =
  | { ok: true; email: string; from: OrgRole; to: OrgRole; ruleManaged: boolean }
  | { ok: false; reason: 'invalid_role' | 'not_found' | 'deactivated' | 'last_admin' };

export const isOrgRole = (value: string | undefined): value is OrgRole =>
  (ORG_ROLES as readonly string[]).includes(value ?? '');

/**
 * `bastion set-role` (20.1): gives an existing account an organization role from the command line. This is the way to
 * make somebody who signs in through the identity provider an administrator when nobody can sign in as one (local
 * password login is off as soon as an IdP connection exists). The change is audited with the system as the actor.
 * `ruleManaged` tells the operator that IdP group mapping rules also set roles, at every sign-in.
 */
export const setRole = async (
  infra: Infra,
  input: { email: string; role: string | undefined },
): Promise<SetRoleResult> => {
  const role = input.role;
  if (!isOrgRole(role)) return { ok: false, reason: 'invalid_role' };
  const user = await infra.repos.users.findByEmail(input.email.trim().toLowerCase());
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.status !== 'active') return { ok: false, reason: 'deactivated' };
  if (user.orgRole === 'admin' && role !== 'admin') {
    const admins = await infra.repos.users.list({ orgRole: 'admin', status: 'active', limit: 200 });
    if (!admins.items.some((a) => a.id !== user.id)) return { ok: false, reason: 'last_admin' };
  }
  await infra.repos.users.update(
    user.id,
    { orgRole: role },
    {
      ifMatch: '*',
      audit: { actorType: 'system', actorId: null },
    },
  );
  const rules = await infra.repos.roleMappingRules.list();
  return {
    ok: true,
    email: user.email,
    from: user.orgRole,
    to: role,
    ruleManaged: rules.some((r) => 'orgRole' in r.mapsTo),
  };
};

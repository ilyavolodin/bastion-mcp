/**
 * Form model of an auto-install policy (11.5) and its request bodies. Constraints mirror
 * `autoInstallCreateSchema` / `autoInstallTargetSchema` of `packages/api/src/schemas/installations.ts`: the target must
 * name everyone, teams, roles or IdP groups (at most 200 teams and groups, groups up to 256 characters).
 */
import { ORG_ROLES } from '@bastion-mcp/core/constants';
import type { Body } from '@/api/schema';
import { type AutoInstallView, chipsToTarget, type TargetChip } from '@/api/views/catalog';

export type PolicyCreateBody = Body<'post', '/auto-install-policies'>;
export type PolicyPatchBody = Body<'patch', '/auto-install-policies/{id}'>;

/** Roles an audience may name: the org roles and `manager` (a member who manages a team). */
export const TARGET_ROLES = [...ORG_ROLES, 'manager'] as const;

export type PolicyForm = {
  entryId: string;
  targets: TargetChip[];
  mode: 'required' | 'default';
  applyToExisting: boolean;
  scope: 'user' | 'team';
  enabled: boolean;
};

export const emptyPolicyForm = (entryId = ''): PolicyForm => ({
  entryId,
  targets: [],
  mode: 'default',
  applyToExisting: true,
  scope: 'user',
  enabled: true,
});

export const formOf = (p: AutoInstallView): PolicyForm => ({
  entryId: p.catalogEntryId,
  targets: p.targets,
  mode: p.mode,
  applyToExisting: p.applyToExisting,
  scope: p.scope,
  enabled: p.enabled,
});

/** The first reason the form cannot be saved. */
export const policyError = (f: PolicyForm): string | undefined => {
  if (!f.entryId) return 'Pick the entry to install';
  if (f.targets.length === 0) return 'Pick at least one target';
  if (f.targets.filter((t) => t.type === 'team').length > 200) return 'At most 200 teams';
  if (f.targets.some((t) => t.type === 'idpGroup' && t.id.length > 256))
    return 'IdP group names are limited to 256 characters';
  return undefined;
};

export const toPolicyCreateBody = (f: PolicyForm): PolicyCreateBody => ({
  catalogEntryId: f.entryId,
  target: chipsToTarget(f.targets),
  mode: f.mode,
  scope: f.scope,
  applyToExisting: f.applyToExisting,
  enabled: f.enabled,
});

export const toPolicyPatchBody = (f: PolicyForm): PolicyPatchBody => ({
  target: chipsToTarget(f.targets),
  mode: f.mode,
  scope: f.scope,
  applyToExisting: f.applyToExisting,
  enabled: f.enabled,
});

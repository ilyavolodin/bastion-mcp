import type { ResourceData } from '@bastion-mcp/policy';
import { z } from 'zod';
import type { ApiDeps } from '../ports';
import type { Row } from '../ports/store';

/**
 * Cedar resource builders (10, ROUTE_ACTIONS notes). Row fields follow the db schema in camelCase:
 * `catalog_entries.{ownerTeamId, visibility, risk}`, `installations.{ownerType, ownerId, catalogEntryId}`.
 * A resolver may load the row it needs to pick the resource; it must not return data to the caller.
 */

const visibilityRow = z
  .object({
    org: z.boolean().default(false),
    teamIds: z.array(z.string()).default([]),
    userIds: z.array(z.string()).default([]),
  })
  .default({ org: false, teamIds: [], userIds: [] });

const RISK = z.enum(['low', 'medium', 'high']).catch('medium');

export const orgResource = (): ResourceData => ({ type: 'Org' });

export const teamResource = (id: string): ResourceData => ({ type: 'Team', id });

export const catalogEntryResource = (row: Row): ResourceData => ({
  type: 'CatalogEntry',
  id: row.id,
  ...(typeof row.ownerTeamId === 'string' ? { ownerTeamId: row.ownerTeamId } : {}),
  visibility: visibilityRow.catch({ org: false, teamIds: [], userIds: [] }).parse(row.visibility),
  risk: RISK.parse(row.risk),
});

/** Loads a catalog entry resource; a missing entry yields `null` (the handler answers 404). */
export const loadCatalogEntryResource = async (
  deps: ApiDeps,
  id: string,
): Promise<ResourceData | null> => {
  const row = await deps.store.get('catalog_entries', id);
  return row ? catalogEntryResource(row) : null;
};

/** An installation as the policy sees it: owner by type, plus the entry's visibility attributes. */
export const installationResource = (row: Row, entry?: Row | null): ResourceData => {
  const ownerId = typeof row.ownerId === 'string' ? row.ownerId : undefined;
  return {
    type: 'Installation',
    id: row.id,
    catalogEntryId: typeof row.catalogEntryId === 'string' ? row.catalogEntryId : row.id,
    ...(row.ownerType === 'user' && ownerId ? { ownerUserId: ownerId } : {}),
    ...(row.ownerType === 'team' && ownerId ? { ownerTeamId: ownerId } : {}),
    ...(row.ownerType === 'service' && ownerId ? { ownerServiceId: ownerId } : {}),
    ...(typeof row.ownerServiceTeamId === 'string'
      ? { ownerServiceTeamId: row.ownerServiceTeamId }
      : {}),
    ...(entry
      ? {
          catalogEntry: {
            ...(typeof entry.ownerTeamId === 'string' ? { ownerTeamId: entry.ownerTeamId } : {}),
            visibility: visibilityRow
              .catch({ org: false, teamIds: [], userIds: [] })
              .parse(entry.visibility),
            risk: RISK.parse(entry.risk),
          },
        }
      : {}),
  };
};

/** Loads an installation resource, with its catalog entry attributes; `null` when it does not exist. */
export const loadInstallationResource = async (
  deps: ApiDeps,
  id: string,
): Promise<ResourceData | null> => {
  const row = await deps.store.get('installations', id);
  if (!row) return null;
  const entry =
    typeof row.catalogEntryId === 'string'
      ? await deps.store.get('catalog_entries', row.catalogEntryId)
      : null;
  let enriched = row;
  if (row.ownerType === 'service' && typeof row.ownerId === 'string') {
    const account = await deps.store.get('service_accounts', row.ownerId);
    if (account && typeof account.teamId === 'string') {
      enriched = { ...row, ownerServiceTeamId: account.teamId };
    }
  }
  return installationResource(enriched, entry);
};

/** The user as a Cedar `User` resource (registry request approval and secrets use it, 10.1). */
export const loadUserResource = async (deps: ApiDeps, id: string): Promise<ResourceData | null> => {
  const user = await deps.store.get('users', id);
  if (!user) return null;
  const memberships = await deps.store.find('team_members', { userId: id });
  const role = user.orgRole === 'admin' || user.orgRole === 'auditor' ? user.orgRole : 'member';
  return {
    type: 'User',
    id,
    role,
    active: user.status !== 'deactivated',
    emailDomain: typeof user.email === 'string' ? (user.email.split('@')[1] ?? '') : '',
    teamIds: memberships.map((m) => String(m.teamId)),
    managedTeamIds: memberships.filter((m) => m.role === 'manager').map((m) => String(m.teamId)),
  };
};

/** Used when the addressed row does not exist: authorization falls back to the broadest check (Org). */
export const orMissing = (resource: ResourceData | null): ResourceData => resource ?? orgResource();

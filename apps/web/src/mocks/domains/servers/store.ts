/** What the servers handlers share: the db slices, who may manage an installation, and what an installation serves. */
import { isAdmin, managesTeam } from '../../roles';
import { ME_ID } from '../../seed';
import { getDb } from '../../state';
import { validationFailed } from '../../util';
import type { Installation } from './types';

const ME = ME_ID;

export const data = () => getDb().data.servers;
export const catalog = () => getDb().data.catalog;
export const validation = validationFailed;

/** Members and auditors manage only their own installations; managers also their teams'; admins all. */
export const canManage = (i: Installation): boolean => {
  if (isAdmin()) return true;
  if (i.ownerType === 'user') return i.ownerId === ME;
  return i.ownerType === 'team' && managesTeam(i.ownerId);
};

export const installationOf = (id: string) => data().installations.find((i) => i.id === id);
export const visibleInstallation = (id: string) => {
  const row = installationOf(id);
  return row && canManage(row) ? row : undefined;
};

export const entryOf = (installation: Installation) =>
  catalog().entries.find((e) => e.id === installation.catalogEntryId);
export const versionOfInstallation = (installation: Installation) =>
  catalog().versions.find((v) => v.id === installation.catalogVersionId);

export const specOf = (installation: Installation): Record<string, unknown> | null =>
  installation.personalSpec ?? versionOfInstallation(installation)?.serverSpec ?? null;

export const authModeOf = (installation: Installation): string => {
  const auth = specOf(installation)?.auth;
  return typeof auth === 'object' && auth !== null && 'mode' in auth ? String(auth.mode) : 'none';
};

export const layersOf = (installation: Installation): (Record<string, unknown> | undefined)[] => [
  versionOfInstallation(installation)?.overrides,
  installation.overrides,
];

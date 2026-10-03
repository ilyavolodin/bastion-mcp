import type { ResourceData } from '@bastion-mcp/policy';
import type { z } from 'zod';
import { ConflictApiError, NotFoundApiError } from '../errors';
import type { ApiDeps } from '../ports';
import type { Row } from '../ports/store';
import type { AutoInstallTarget, autoInstallPreviewSchema } from '../schemas/installations';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';
import { orgResource, teamResource } from './resources';

export const autoInstallPolicies = new CrudService({
  collection: 'auto_install_policies',
  targetType: 'auto_install_policy',
  action: 'auto_install_policy',
  configTopic: 'auto_install',
});

/**
 * Who may author a policy (ROUTE_ACTIONS): a policy that targets exactly one team is that team's (managers
 * of T); anything wider (all users, roles, IdP groups, several teams) is org-level (admins).
 */
export const targetResource = (
  target: AutoInstallTarget,
): { rule: string; resource: ResourceData } => {
  const onlyTeam =
    target.all !== true &&
    (target.roles?.length ?? 0) === 0 &&
    (target.idpGroups?.length ?? 0) === 0 &&
    target.teamIds?.length === 1;
  const teamId = target.teamIds?.[0];
  return onlyTeam && teamId !== undefined
    ? { rule: 'auto-install.team', resource: teamResource(teamId) }
    : { rule: 'auto-install.org', resource: orgResource() };
};

export const storedTarget = (row: Row | null): AutoInstallTarget | null => {
  const t = row?.target;
  if (typeof t !== 'object' || t === null) return null;
  return t as AutoInstallTarget;
};

export const createPolicy = async (
  ctx: WriteCtx,
  body: {
    catalogEntryId: string;
    target: AutoInstallTarget;
    mode: string;
    scope: string;
    applyToExisting: boolean;
    enabled: boolean;
  },
): Promise<Row> => {
  const entry = await ctx.tx.store.get('catalog_entries', body.catalogEntryId);
  if (!entry) throw new NotFoundApiError('catalog entry');
  if (entry.status !== 'published') {
    throw new ConflictApiError('only published entries can be auto-installed', {
      code: 'entry_not_published',
    });
  }
  return autoInstallPolicies.create(ctx, { ...body, createdBy: ctx.principal.id });
};

export const updatePolicy = async (ctx: WriteCtx, id: string, patch: Record<string, unknown>) => {
  const before = await ctx.tx.store.get('auto_install_policies', id);
  if (!before) throw new NotFoundApiError('auto-install policy');
  const target = patch.target as AutoInstallTarget | undefined;
  if (target) {
    // The caller must also be allowed to author the new target (a manager cannot widen a policy).
    const next = targetResource(target);
    ctx.authorize('policy.edit', next.resource);
  }
  return autoInstallPolicies.update(ctx, id, patch);
};

// --- preview ------------------------------------------------------------------------------------------

export type Preview = z.output<typeof autoInstallPreviewSchema>;

export type PreviewData = {
  users: readonly Row[];
  memberships: readonly Row[];
  teams: readonly Row[];
  installations: readonly Row[];
  applications: readonly Row[];
  /** True when the entry's current version asks each user for input (OAuth or a user secret) (9.5). */
  needsPerUserSetup: boolean;
};

export type PreviewPolicy = {
  id: string;
  catalogEntryId: string;
  target: AutoInstallTarget;
  mode: string;
  scope: string;
  applyToExisting: boolean;
};

const SAMPLE_SIZE = 20;

const matchesTarget = (
  user: Row,
  target: AutoInstallTarget,
  teamsOf: ReadonlyMap<string, Row[]>,
): boolean => {
  if (target.all === true) return true;
  const memberships = teamsOf.get(user.id) ?? [];
  if (target.teamIds?.some((t) => memberships.some((m) => m.teamId === t))) return true;
  if (
    target.roles?.some((r) =>
      r === 'manager' ? memberships.some((m) => m.role === 'manager') : user.orgRole === r,
    )
  ) {
    return true;
  }
  const groups = Array.isArray(user.idpGroups) ? user.idpGroups : [];
  return target.idpGroups?.some((g) => groups.includes(g)) ?? false;
};

/**
 * Pure: who would get what (11.5). Users are matched by the target; `required`/`default` policies skip
 * subjects that already have the entry installed or were already applied (so removed `default` installs are
 * not re-added); a `team` scope policy produces one installation per matched team.
 */
export const computePreview = (policy: PreviewPolicy, data: PreviewData): Preview => {
  const active = data.users.filter((u) => u.status !== 'deactivated');
  const teamsOf = new Map<string, Row[]>();
  for (const m of data.memberships) {
    const list = teamsOf.get(String(m.userId)) ?? [];
    list.push(m);
    teamsOf.set(String(m.userId), list);
  }
  const matched = active.filter((u) => matchesTarget(u, policy.target, teamsOf));
  const applied = new Set(
    data.applications
      .filter((a) => a.policyId === policy.id)
      .map((a) => `${String(a.subjectType)}:${String(a.subjectId)}`),
  );
  const slugOf = new Map(data.teams.map((t) => [t.id, typeof t.slug === 'string' ? t.slug : null]));
  const entryInstalls = data.installations.filter(
    (i) => i.catalogEntryId === policy.catalogEntryId,
  );

  // Teams the matched users belong to (the "6 teams" of the summary).
  const byTeam = new Map<string, number>();
  for (const user of matched) {
    for (const m of teamsOf.get(user.id) ?? []) {
      byTeam.set(String(m.teamId), (byTeam.get(String(m.teamId)) ?? 0) + 1);
    }
  }
  const relevantTeams = [...byTeam.keys()];

  let willInstall = 0;
  let alreadyInstalled = 0;
  let skippedRemoved = 0;
  const installTargets: string[] = [];
  if (policy.scope === 'team') {
    const teamIds = policy.target.teamIds?.length ? policy.target.teamIds : relevantTeams;
    for (const teamId of new Set(teamIds)) {
      if (entryInstalls.some((i) => i.ownerType === 'team' && i.ownerId === teamId))
        alreadyInstalled += 1;
      else if (policy.mode === 'default' && applied.has(`team:${teamId}`)) skippedRemoved += 1;
      else willInstall += 1;
    }
  } else {
    for (const user of matched) {
      if (entryInstalls.some((i) => i.ownerType === 'user' && i.ownerId === user.id))
        alreadyInstalled += 1;
      else if (policy.mode === 'default' && applied.has(`user:${user.id}`)) skippedRemoved += 1;
      else {
        willInstall += 1;
        installTargets.push(user.id);
      }
    }
  }
  if (!policy.applyToExisting && policy.scope !== 'team') {
    // New users only: nobody who exists today gets it.
    skippedRemoved += willInstall;
    willInstall = 0;
    installTargets.length = 0;
  }
  const mustConnect = policy.scope === 'user' && data.needsPerUserSetup ? willInstall : 0;
  const users = matched.length;
  const teams = relevantTeams.length;
  const summary = `${users} ${users === 1 ? 'person' : 'people'} in ${teams} ${teams === 1 ? 'team' : 'teams'} get this${
    mustConnect > 0 ? `; ${mustConnect} must connect their account` : ''
  }`;
  return {
    summary,
    users,
    teams,
    willInstall,
    alreadyInstalled,
    skippedRemoved,
    mustConnect,
    byTeam: [...byTeam].map(([teamId, n]) => ({
      teamId,
      slug: slugOf.get(teamId) ?? null,
      users: n,
    })),
    sample: matched.slice(0, SAMPLE_SIZE).map((u) => ({
      userId: u.id,
      displayName: typeof u.displayName === 'string' ? u.displayName : u.id,
    })),
  };
};

const PER_USER_MODES = new Set(['oauth', 'userSecret']);

const needsPerUser = async (deps: ApiDeps, entry: Row | null): Promise<boolean> => {
  const versionId = typeof entry?.currentVersionId === 'string' ? entry.currentVersionId : null;
  const version = versionId ? await deps.store.get('catalog_versions', versionId) : null;
  const spec = version?.serverSpec;
  if (typeof spec !== 'object' || spec === null) return false;
  const auth = (spec as { auth?: { mode?: unknown } }).auth;
  return typeof auth?.mode === 'string' && PER_USER_MODES.has(auth.mode);
};

export const previewPolicy = async (
  ctx: Pick<ReadCtx, 'deps'>,
  id: string,
  overrides: Partial<Pick<PreviewPolicy, 'target' | 'mode' | 'scope' | 'applyToExisting'>>,
): Promise<Preview> => {
  const row = await ctx.deps.store.get('auto_install_policies', id);
  if (!row) throw new NotFoundApiError('auto-install policy');
  const stored = storedTarget(row);
  const policy: PreviewPolicy = {
    id,
    catalogEntryId: String(row.catalogEntryId),
    target: overrides.target ?? stored ?? { all: true },
    mode: overrides.mode ?? String(row.mode),
    scope: overrides.scope ?? String(row.scope),
    applyToExisting: overrides.applyToExisting ?? row.applyToExisting !== false,
  };
  const { store } = ctx.deps;
  const entry = await store.get('catalog_entries', policy.catalogEntryId);
  const [users, memberships, teams, installations, applications] = await Promise.all([
    store.find('users', {}),
    store.find('team_members', {}),
    store.find('teams', {}),
    store.find('installations', { catalogEntryId: policy.catalogEntryId }),
    store.find('auto_install_applications', { policyId: id }),
  ]);
  return computePreview(policy, {
    users,
    memberships,
    teams,
    installations,
    applications,
    needsPerUserSetup: await needsPerUser(ctx.deps, entry),
  });
};

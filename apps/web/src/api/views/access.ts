/**
 * What the Access screens show, built from the rows of the API. The API returns bare rows (a user has no team list,
 * a membership has no name, an OAuth client has no status), so the screens join them here. Everything is derived
 * from the generated schema types; nothing restates an API body.
 */
import { pad2 } from '@/lib/format';
import type { Body, OrgRole, Schemas, TeamRole } from '../schema';

// --- people and teams -------------------------------------------------------------------------------------------

export type TeamRef = { id: string; name: string; role: TeamRole };

export type UserSource = 'idp' | 'scim' | 'manual';

export type UserView = Pick<Schemas['User'], 'id' | 'email' | 'status' | 'updatedAt'> & {
  /** `displayName` of the row. */
  name: string;
  orgRole: OrgRole;
  teams: TeamRef[];
  /** `lastLoginAt` of the row. */
  lastActiveAt: string | null;
  source: UserSource;
};

export type TeamMemberView = {
  userId: string;
  name: string;
  role: TeamRole;
  source: Schemas['TeamMember']['source'];
};

export type TeamView = Pick<Schemas['Team'], 'id' | 'slug' | 'idpGroup' | 'updatedAt'> & {
  /** `displayName` of the row. */
  name: string;
  members: TeamMemberView[];
  /** Display names of the managers. */
  managers: string[];
  memberCount: number;
};

export type Directory = { users: UserView[]; teams: TeamView[] };

/** Where a person comes from: SCIM provisioning, an IdP login, or an account an admin created. */
export const sourceOf = (
  user: Pick<Schemas['User'], 'idpConnectionId' | 'scimExternalId'>,
): UserSource => (user.scimExternalId ? 'scim' : user.idpConnectionId ? 'idp' : 'manual');

/** Joins users, teams and memberships into the shapes the screens use. */
export const buildDirectory = (
  users: readonly Schemas['User'][],
  details: readonly Schemas['TeamDetail'][],
): Directory => {
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
  const teams: TeamView[] = details.map((t) => {
    const members: TeamMemberView[] = t.members.map((m) => ({
      userId: m.userId,
      name: nameOf.get(m.userId) ?? m.userId,
      role: m.role,
      source: m.source,
    }));
    return {
      id: t.id,
      slug: t.slug,
      idpGroup: t.idpGroup,
      updatedAt: t.updatedAt,
      name: t.displayName,
      members,
      managers: members.filter((m) => m.role === 'manager').map((m) => m.name),
      memberCount: members.length,
    };
  });
  const views: UserView[] = users.map((u) => ({
    id: u.id,
    email: u.email,
    status: u.status,
    updatedAt: u.updatedAt,
    name: u.displayName,
    orgRole: u.orgRole,
    teams: teams.flatMap((t) => {
      const m = t.members.find((x) => x.userId === u.id);
      return m ? [{ id: t.id, name: t.name, role: m.role }] : [];
    }),
    lastActiveAt: u.lastLoginAt,
    source: sourceOf(u),
  }));
  return { users: views, teams };
};

export const filterUsers = (
  users: readonly UserView[],
  params: { q?: string | undefined; teamId?: string | undefined },
): UserView[] => {
  const text = (params.q ?? '').trim().toLowerCase();
  return users.filter(
    (u) =>
      (!text || `${u.name} ${u.email}`.toLowerCase().includes(text)) &&
      (!params.teamId || u.teams.some((t) => t.id === params.teamId)),
  );
};

// --- IdP group mapping ------------------------------------------------------------------------------------------

export type MapsTo = Schemas['RoleMappingRule']['mapsTo'];

/** One line for what a mapping rule does: `{ kind: 'role' | 'team', label }`. */
export const describeMapsTo = (
  mapsTo: MapsTo,
  teams: readonly Pick<TeamView, 'id' | 'name'>[],
): { kind: 'role' | 'team'; label: string } => {
  if ('orgRole' in mapsTo) return { kind: 'role', label: mapsTo.orgRole };
  if ('createTeam' in mapsTo) {
    return { kind: 'team', label: `A team per group · ${mapsTo.teamRole ?? 'member'}` };
  }
  const name = teams.find((t) => t.id === mapsTo.teamId)?.name ?? mapsTo.teamId;
  return { kind: 'team', label: `${name} · ${mapsTo.teamRole}` };
};

// --- OAuth clients ----------------------------------------------------------------------------------------------

export type OAuthStatus = 'approved' | 'blocked' | 'pending';

/** A client policy is blocked, pre-approved, or still waiting for a decision. */
export const oauthStatus = (
  c: Pick<Schemas['OAuthClientPolicy'], 'blocked' | 'preApproved'>,
): OAuthStatus => (c.blocked ? 'blocked' : c.preApproved ? 'approved' : 'pending');

/** A client id is a metadata-document URL (CIMD) or an opaque id (DCR, pre-registered). */
export const oauthRegistration = (clientId: string): 'cimd' | 'registered' =>
  /^https:\/\//.test(clientId) ? 'cimd' : 'registered';

/** The host of a metadata-document client id, else the id itself. */
export const oauthName = (clientId: string): string => {
  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId;
  }
};

// --- tool rules -------------------------------------------------------------------------------------------------

type RuleBody = Body<'post', '/policy-rules'>;
export type RuleWho = NonNullable<RuleBody['who']>;
export type RuleWhat = NonNullable<RuleBody['what']>;
export type RuleWhen = NonNullable<RuleBody['when']>;

export type RuleLookups = {
  teams: readonly { id: string; name: string }[];
  users: readonly { id: string; name: string }[];
  serviceAccounts: readonly { id: string; name: string }[];
  installations: readonly { id: string; displayName: string }[];
  entries?: readonly { id: string; displayName: string }[] | undefined;
};

export type Chip = { key: string; label: string };

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  member: 'Member',
  manager: 'Manager',
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const nameIn = <T extends { id: string }>(
  list: readonly T[],
  id: string,
  pick: (item: T) => string,
): string => {
  const found = list.find((x) => x.id === id);
  return found ? pick(found) : id;
};

/** The "who" of a rule as chips; an empty `who` means everyone. */
export const whoChips = (who: RuleWho, l: RuleLookups): Chip[] => {
  const chips: Chip[] = [];
  if (who.role)
    chips.push({ key: `role:${who.role}`, label: `Role · ${ROLE_LABEL[who.role] ?? who.role}` });
  for (const id of who.teams ?? []) {
    chips.push({ key: `team:${id}`, label: `Team · ${nameIn(l.teams, id, (t) => t.name)}` });
  }
  for (const id of who.users ?? []) {
    chips.push({ key: `user:${id}`, label: `Person · ${nameIn(l.users, id, (u) => u.name)}` });
  }
  for (const id of who.serviceAccounts ?? []) {
    chips.push({
      key: `service:${id}`,
      label: `Service account · ${nameIn(l.serviceAccounts, id, (s) => s.name)}`,
    });
  }
  return chips.length > 0 ? chips : [{ key: 'everyone', label: 'Everyone' }];
};

/** The "what" of a rule as chips; an empty `what` covers every tool. */
export const whatChips = (what: RuleWhat, l: RuleLookups): Chip[] => {
  const chips: Chip[] = [];
  if (what.installationId) {
    chips.push({
      key: `installation:${what.installationId}`,
      label: nameIn(l.installations, what.installationId, (i) => i.displayName),
    });
  }
  if (what.catalogEntryId) {
    chips.push({
      key: `entry:${what.catalogEntryId}`,
      label: nameIn(l.entries ?? [], what.catalogEntryId, (e) => e.displayName),
    });
  }
  if (what.toolName) chips.push({ key: `tool:${what.toolName}`, label: what.toolName });
  const a = what.annotations;
  if (a?.destructive) chips.push({ key: 'ann:destructive', label: 'destructive tools' });
  if (a?.readOnly) chips.push({ key: 'ann:readOnly', label: 'read-only tools' });
  if (a?.openWorld) chips.push({ key: 'ann:openWorld', label: 'open-world tools' });
  return chips.length > 0 ? chips : [{ key: 'any', label: 'Any tool' }];
};

/** The conditions of a rule as chips. */
export const whenChips = (when: RuleWhen): Chip[] => {
  const chips: Chip[] = [];
  if (when.hours) {
    chips.push({
      key: 'hours',
      label: `Hours ${pad2(when.hours.from)}:00–${pad2(when.hours.to)}:00`,
    });
  }
  if (when.weekdays?.length) {
    chips.push({
      key: 'weekdays',
      label: [...when.weekdays]
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d])
        .join(', '),
    });
  }
  for (const c of when.clientIds ?? []) chips.push({ key: `client:${c}`, label: `Client · ${c}` });
  for (const ip of when.ipCidrs ?? []) chips.push({ key: `ip:${ip}`, label: `IP · ${ip}` });
  for (const [i, arg] of (when.args ?? []).entries()) {
    const detail =
      'value' in arg
        ? `${arg.op === 'ne' ? '≠' : '='} ${arg.value}`
        : 'values' in arg
          ? `in ${arg.values.join(', ')}`
          : 'pattern' in arg
            ? `like ${arg.pattern}`
            : arg.op === 'exists'
              ? 'exists'
              : 'is missing';
    chips.push({ key: `arg:${i}`, label: `Argument ${arg.name} ${detail}` });
  }
  return chips;
};

const without = <T>(list: readonly T[] | undefined, drop: T): T[] | undefined => {
  const rest = (list ?? []).filter((x) => x !== drop);
  return rest.length > 0 ? rest : undefined;
};

const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Removes the chip with this key from a `who`. */
export const removeWho = (who: RuleWho, key: string): RuleWho => {
  const [kind, id = ''] = key.split(/:(.*)/s);
  return compact({
    ...(kind === 'role' ? {} : who.role ? { role: who.role } : {}),
    teams: kind === 'team' ? without(who.teams, id) : who.teams,
    users: kind === 'user' ? without(who.users, id) : who.users,
    serviceAccounts: kind === 'service' ? without(who.serviceAccounts, id) : who.serviceAccounts,
  });
};

/** Removes the chip with this key from a `what`. */
export const removeWhat = (what: RuleWhat, key: string): RuleWhat => {
  const [kind, id = ''] = key.split(/:(.*)/s);
  const annotations = { ...(what.annotations ?? {}) };
  if (kind === 'ann') delete annotations[id as keyof typeof annotations];
  return compact({
    installationId: kind === 'installation' ? undefined : what.installationId,
    catalogEntryId: kind === 'entry' ? undefined : what.catalogEntryId,
    toolName: kind === 'tool' ? undefined : what.toolName,
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
  });
};

/** Removes the chip with this key from a `when`. */
export const removeWhen = (when: RuleWhen, key: string): RuleWhen => {
  const [kind, id = ''] = key.split(/:(.*)/s);
  return compact({
    clientIds: kind === 'client' ? without(when.clientIds, id) : when.clientIds,
    hours: kind === 'hours' ? undefined : when.hours,
    weekdays: kind === 'weekdays' ? undefined : when.weekdays,
    ipCidrs: kind === 'ip' ? without(when.ipCidrs, id) : when.ipCidrs,
    args: kind === 'arg' ? when.args?.filter((_, i) => String(i) !== id) : when.args,
  });
};

/** Adds a value to a list field, once. */
export const addTo = <T>(list: readonly T[] | undefined, value: T): T[] =>
  (list ?? []).includes(value) ? [...(list ?? [])] : [...(list ?? []), value];

export const ruleScopeLabel = (
  rule: Pick<Schemas['PolicyRule'], 'ownerTeamId'>,
  teams: readonly { id: string; name: string }[],
): string =>
  rule.ownerTeamId ? `Team rule · ${nameIn(teams, rule.ownerTeamId, (t) => t.name)}` : 'Org rule';

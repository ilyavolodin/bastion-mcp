import type { PrincipalRecord } from '@bastion-mcp/auth';
import type { MemoryStore } from './memory-store';

/** Stable ids of the seeded organization used by every API test (23.3 fixtures). */
export const W = {
  teamA: 'team-a',
  teamB: 'team-b',
  admin: 'user-admin',
  managerA: 'user-manager-a',
  managerB: 'user-manager-b',
  memberA: 'user-member-a',
  memberB: 'user-member-b',
  auditor: 'user-auditor',
  svc: 'svc-a',
} as const;

export const ACTORS = [
  'admin',
  'managerOwn',
  'managerOther',
  'member',
  'auditor',
  'service',
  'anonymous',
] as const;
export type ActorName = (typeof ACTORS)[number];

/** Principal records per actor. `managerOwn` manages team A (the team fixtures live in); `managerOther` team B. */
export const PRINCIPAL_RECORDS: Record<Exclude<ActorName, 'anonymous'>, PrincipalRecord> = {
  admin: { id: W.admin, type: 'user', orgRole: 'admin', teams: [], active: true },
  managerOwn: {
    id: W.managerA,
    type: 'user',
    orgRole: 'member',
    teams: [{ teamId: W.teamA, role: 'manager' }],
    active: true,
  },
  managerOther: {
    id: W.managerB,
    type: 'user',
    orgRole: 'member',
    teams: [{ teamId: W.teamB, role: 'manager' }],
    active: true,
  },
  member: {
    id: W.memberA,
    type: 'user',
    orgRole: 'member',
    teams: [{ teamId: W.teamA, role: 'member' }],
    active: true,
  },
  auditor: { id: W.auditor, type: 'user', orgRole: 'auditor', teams: [], active: true },
  service: {
    id: W.svc,
    type: 'service',
    orgRole: 'member',
    teams: [{ teamId: W.teamA, role: 'member' }],
    active: true,
  },
};

export const tokenFor = (actor: Exclude<ActorName, 'anonymous'>): string => `tok-${actor}`;

/** Seeds users, teams and memberships (16.2) shared by all areas. */
export const seedWorld = async (store: MemoryStore): Promise<void> => {
  await store.seed('teams', { id: W.teamA, slug: 'team-a', displayName: 'Team A' });
  await store.seed('teams', { id: W.teamB, slug: 'team-b', displayName: 'Team B' });
  const users: Array<[string, string, string]> = [
    [W.admin, 'admin@example.com', 'admin'],
    [W.managerA, 'manager-a@example.com', 'member'],
    [W.managerB, 'manager-b@example.com', 'member'],
    [W.memberA, 'member-a@example.com', 'member'],
    [W.memberB, 'member-b@example.com', 'member'],
    [W.auditor, 'auditor@example.com', 'auditor'],
  ];
  for (const [id, email, role] of users) {
    await store.seed('users', {
      id,
      email,
      displayName: email.split('@')[0],
      orgRole: role,
      status: 'active',
    });
  }
  const members: Array<[string, string, string]> = [
    [W.teamA, W.managerA, 'manager'],
    [W.teamB, W.managerB, 'manager'],
    [W.teamA, W.memberA, 'member'],
    [W.teamB, W.memberB, 'member'],
  ];
  for (const [teamId, userId, role] of members) {
    await store.seed('team_members', {
      id: `${teamId}:${userId}`,
      teamId,
      userId,
      role,
      source: 'manual',
    });
  }
  await store.seed('service_accounts', {
    id: W.svc,
    teamId: W.teamA,
    slug: 'ci',
    displayName: 'CI',
    status: 'active',
  });
};

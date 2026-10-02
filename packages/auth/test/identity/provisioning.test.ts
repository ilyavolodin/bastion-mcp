import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DeactivationAction,
  evaluateRules,
  executeDeactivation,
  externalSubjectFor,
  type IdpConnection,
  isEmailDomainAllowed,
  mapClaims,
  ProvisioningDeniedError,
  planDeactivation,
  planLogin,
  type RoleMappingRule,
  type UserState,
} from '../../src/identity';

const conn: IdpConnection = {
  id: 'idp-1',
  issuer: 'https://idp.example.com',
  claimMap: {},
  emailDomains: [],
  enabled: true,
};

const rule = (
  over: Partial<RoleMappingRule> & Pick<RoleMappingRule, 'mapsTo'>,
): RoleMappingRule => ({
  id: 'r1',
  idpConnectionId: null,
  groupPattern: 'x',
  priority: 100,
  ...over,
});

let counter = 0;
const newId = () => `id-${++counter}`;
const now = new Date('2026-06-01T00:00:00Z');

describe('9.1 claim mapping and allowed domains', () => {
  it('9.1 maps sub, email, name and groups with default claim names', () => {
    const c = mapClaims(
      { sub: 'abc', email: 'Ann@Example.com', name: 'Ann', groups: ['a', 'b', 'a'] },
      conn,
    );
    expect(c).toEqual({
      sub: 'abc',
      email: 'ann@example.com',
      displayName: 'Ann',
      groups: ['a', 'b'],
    });
  });

  it('9.1 honours a custom claim map, dotted paths and comma-separated groups', () => {
    const c = mapClaims(
      { uid: 7, mail: 'a@b.io', cn: 'A', realm: { roles: 'x, y' } },
      { ...conn, claimMap: { sub: 'uid', email: 'mail', name: 'cn', groups: 'realm.roles' } },
    );
    expect(c).toEqual({ sub: '7', email: 'a@b.io', displayName: 'A', groups: ['x', 'y'] });
  });

  it('9.1 falls back to the email local part for the name and rejects bad claims', () => {
    expect(mapClaims({ sub: 's', email: 'bob@x.io' }, conn).displayName).toBe('bob');
    for (const bad of [
      null,
      'str',
      {},
      { sub: 's' },
      { sub: 's', email: 'nope' },
      { email: 'a@b.io' },
    ]) {
      expect(() => mapClaims(bad, conn)).toThrow(ProvisioningDeniedError);
    }
    expect(() => mapClaims({ sub: 's', email: 'a@b.io', email_verified: false }, conn)).toThrow(
      ProvisioningDeniedError,
    );
  });

  it('9.1 enforces allowed email domains', () => {
    const limited = { ...conn, emailDomains: ['Example.com'] };
    expect(() => mapClaims({ sub: 's', email: 'a@example.com' }, limited)).not.toThrow();
    expect(() => mapClaims({ sub: 's', email: 'a@evil.com' }, limited)).toThrow(
      ProvisioningDeniedError,
    );
    expect(() => mapClaims({ sub: 's', email: 'a@sub.example.com' }, limited)).toThrow(
      ProvisioningDeniedError,
    );
    expect(isEmailDomainAllowed('a@b.io', [])).toBe(true);
  });

  it('9.1 external_subject is issuer + sub', () => {
    expect(externalSubjectFor('https://idp.example.com', 'abc')).toBe(
      'https://idp.example.com#abc',
    );
  });
});

describe('9.1 group mapping rules', () => {
  const existingTeams = [{ id: 't-eng', slug: 'eng', idpGroup: 'eng' }];

  it('9.1 maps a group to an org role; lowest priority number wins', () => {
    const r = evaluateRules({
      rules: [
        rule({ id: 'a', groupPattern: 'bastion-.*', mapsTo: { orgRole: 'auditor' }, priority: 50 }),
        rule({
          id: 'b',
          groupPattern: 'bastion-admins',
          mapsTo: { orgRole: 'admin' },
          priority: 10,
        }),
      ],
      connectionId: 'idp-1',
      groups: ['bastion-admins'],
      existingTeams,
      newId,
    });
    expect(r.orgRole).toBe('admin');
    expect(r.orgRoleManaged).toBe(true);
  });

  it('9.1 patterns are anchored full matches', () => {
    const rules = [rule({ groupPattern: 'admins', mapsTo: { orgRole: 'admin' } })];
    const hit = evaluateRules({
      rules,
      connectionId: 'c',
      groups: ['admins'],
      existingTeams: [],
      newId,
    });
    const miss = evaluateRules({
      rules,
      connectionId: 'c',
      groups: ['super-admins'],
      existingTeams: [],
      newId,
    });
    expect(hit.orgRole).toBe('admin');
    expect(miss.orgRole).toBeNull();
    expect(miss.orgRoleManaged).toBe(true);
  });

  it('9.1 explicit mapping to a team and role; managers beat members', () => {
    const r = evaluateRules({
      rules: [
        rule({ id: 'a', groupPattern: 'g1', mapsTo: { teamId: 't1', teamRole: 'member' } }),
        rule({ id: 'b', groupPattern: 'g2', mapsTo: { teamId: 't1', teamRole: 'manager' } }),
      ],
      connectionId: 'c',
      groups: ['g1', 'g2'],
      existingTeams: [],
      newId,
    });
    expect(r.memberships).toEqual([{ teamId: 't1', role: 'manager' }]);
    expect(r.orgRoleManaged).toBe(false);
  });

  it('9.1 createTeam creates one team per matching group and reuses existing ones', () => {
    const r = evaluateRules({
      rules: [rule({ groupPattern: 'eng|design-.*', mapsTo: { createTeam: true } })],
      connectionId: 'c',
      groups: ['eng', 'design-ux', 'sales'],
      existingTeams,
      newId,
    });
    expect(r.memberships).toHaveLength(2);
    expect(r.memberships).toContainEqual({ teamId: 't-eng', role: 'member' });
    expect(r.createTeams).toHaveLength(1);
    expect(r.createTeams[0]).toMatchObject({
      slug: 'design-ux',
      displayName: 'design-ux',
      idpGroup: 'design-ux',
    });
  });

  it('9.1 skips groups that cannot become a valid slug and reports a warning', () => {
    const r = evaluateRules({
      rules: [rule({ groupPattern: '.*', mapsTo: { createTeam: true } })],
      connectionId: 'c',
      groups: ['???'],
      existingTeams: [],
      newId,
    });
    expect(r.createTeams).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('9.1 rules of another IdP connection are ignored', () => {
    const r = evaluateRules({
      rules: [rule({ idpConnectionId: 'other', groupPattern: 'a', mapsTo: { orgRole: 'admin' } })],
      connectionId: 'c',
      groups: ['a'],
      existingTeams: [],
      newId,
    });
    expect(r.orgRole).toBeNull();
    expect(r.orgRoleManaged).toBe(false);
  });

  it('9.1 uses RE2: catastrophic patterns finish fast, unsafe constructs are rejected with a warning', () => {
    const start = Date.now();
    const r = evaluateRules({
      rules: [
        rule({ id: 'a', groupPattern: '(a+)+$', mapsTo: { orgRole: 'admin' } }),
        rule({ id: 'b', groupPattern: '(a)\\1', mapsTo: { orgRole: 'admin' } }),
        rule({ id: 'c', groupPattern: 'x'.repeat(300), mapsTo: { orgRole: 'admin' } }),
      ],
      connectionId: 'c',
      groups: [`${'a'.repeat(5000)}!`],
      existingTeams: [],
      newId,
    });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.orgRole).toBeNull();
    expect(r.warnings).toHaveLength(2);
  });

  it('9.1 property: evaluation is order independent for the same priorities', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(['a', 'b', 'c', 'd'], { minLength: 1 }), (groups) => {
        const rules = [
          rule({ id: '1', groupPattern: 'a', mapsTo: { teamId: 't1', teamRole: 'member' } }),
          rule({ id: '2', groupPattern: 'b', mapsTo: { teamId: 't2', teamRole: 'manager' } }),
        ];
        const x = evaluateRules({ rules, connectionId: 'c', groups, existingTeams: [], newId });
        const y = evaluateRules({
          rules: [...rules].reverse(),
          connectionId: 'c',
          groups: [...groups].reverse(),
          existingTeams: [],
          newId,
        });
        const norm = (m: { teamId: string; role: string }[]) =>
          [...m].sort((p, q) => p.teamId.localeCompare(q.teamId));
        expect(norm(x.memberships)).toEqual(norm(y.memberships));
        expect(x.orgRole).toEqual(y.orgRole);
      }),
    );
  });
});

describe('9.1 JIT provisioning plans', () => {
  const claims = {
    sub: 's1',
    email: 'ann@example.com',
    displayName: 'Ann',
    groups: ['bastion-admins', 'eng'],
  };
  const rules = [
    rule({ id: 'a', groupPattern: 'bastion-admins', mapsTo: { orgRole: 'admin' } }),
    rule({ id: 'b', groupPattern: 'eng', mapsTo: { createTeam: true } }),
  ];
  const base = { connection: conn, claims, rules, teams: [], now, newId };

  const user = (over: Partial<UserState> = {}): UserState => ({
    id: 'u1',
    email: 'ann@example.com',
    displayName: 'Ann',
    orgRole: 'member',
    status: 'active',
    idpConnectionId: 'idp-1',
    externalSubject: 'https://idp.example.com#s1',
    isLocal: false,
    memberships: [],
    ...over,
  });

  it('9.1 first login creates the user with external_subject = issuer + sub, mapped role and teams', () => {
    const plan = planLogin({ ...base, existingUser: null });
    expect(plan.user).toMatchObject({
      kind: 'create',
      email: 'ann@example.com',
      externalSubject: 'https://idp.example.com#s1',
      idpConnectionId: 'idp-1',
      orgRole: 'admin',
    });
    expect(plan.createTeams).toHaveLength(1);
    expect(plan.membershipUpserts).toEqual([
      expect.objectContaining({ role: 'member', source: 'idp', teamId: plan.createTeams[0]?.id }),
    ]);
    expect(plan.events.map((e) => e.type)).toEqual(['user.created', 'team.member_added']);
  });

  it('9.1 defaults the role to member when no rule maps one', () => {
    const plan = planLogin({ ...base, rules: [], existingUser: null });
    expect(plan.user).toMatchObject({ kind: 'create', orgRole: 'member' });
  });

  it('9.1 re-evaluates on every login: demotes when the admin group is gone', () => {
    const plan = planLogin({
      ...base,
      claims: { ...claims, groups: [] },
      existingUser: user({ orgRole: 'admin' }),
    });
    expect(plan.user).toMatchObject({ kind: 'update', changes: { orgRole: 'member' } });
    expect(plan.events.map((e) => e.type)).toContain('user.role_changed');
  });

  it('9.1 keeps a manually assigned role when no org-role rules exist', () => {
    const plan = planLogin({
      ...base,
      rules: [],
      claims: { ...claims, groups: [] },
      existingUser: user({ orgRole: 'auditor' }),
    });
    expect(plan.user).toMatchObject({ kind: 'update' });
    expect(plan.user.kind === 'update' && plan.user.changes.orgRole).toBeUndefined();
  });

  it('9.1 removes only idp-sourced memberships that are no longer mapped, keeps manual ones', () => {
    const plan = planLogin({
      ...base,
      rules: [],
      claims: { ...claims, groups: [] },
      existingUser: user({
        memberships: [
          { teamId: 't-old', role: 'member', source: 'idp' },
          { teamId: 't-manual', role: 'manager', source: 'manual' },
          { teamId: 't-scim', role: 'member', source: 'scim' },
        ],
      }),
    });
    expect(plan.membershipRemovals).toEqual([{ teamId: 't-old', userId: 'u1' }]);
  });

  it('9.1 does not override a manual membership and updates an idp role change', () => {
    const r = [rule({ groupPattern: 'g', mapsTo: { teamId: 't1', teamRole: 'manager' } })];
    const manual = planLogin({
      ...base,
      rules: r,
      claims: { ...claims, groups: ['g'] },
      existingUser: user({ memberships: [{ teamId: 't1', role: 'member', source: 'manual' }] }),
    });
    expect(manual.membershipUpserts).toEqual([]);
    const idp = planLogin({
      ...base,
      rules: r,
      claims: { ...claims, groups: ['g'] },
      existingUser: user({ memberships: [{ teamId: 't1', role: 'member', source: 'idp' }] }),
    });
    expect(idp.membershipUpserts).toEqual([
      { teamId: 't1', userId: 'u1', role: 'manager', source: 'idp' },
    ]);
  });

  it('9.1 links a pre-created user (no external subject) on first login and records last login', () => {
    const plan = planLogin({
      ...base,
      existingUser: user({ externalSubject: null, idpConnectionId: null, displayName: 'Old' }),
    });
    expect(plan.user).toMatchObject({
      kind: 'update',
      changes: {
        externalSubject: 'https://idp.example.com#s1',
        idpConnectionId: 'idp-1',
        displayName: 'Ann',
        lastLoginAt: now,
      },
    });
  });

  it('9.1 denies deactivated users, a different external subject, local admins and disabled connections', () => {
    const deny = (input: Parameters<typeof planLogin>[0]) =>
      expect(() => planLogin(input)).toThrow(ProvisioningDeniedError);
    deny({ ...base, existingUser: user({ status: 'deactivated' }) });
    deny({ ...base, existingUser: user({ externalSubject: 'https://idp.example.com#other' }) });
    deny({ ...base, existingUser: user({ externalSubject: null, isLocal: true }) });
    deny({ ...base, existingUser: user({ idpConnectionId: 'idp-2' }) });
    deny({ ...base, connection: { ...conn, enabled: false }, existingUser: null });
  });
});

describe('9.1 deactivation', () => {
  it('9.1 plans the ordered actions: mark inactive, revoke tokens, sessions, instances, upstream tokens', () => {
    const plan = planDeactivation({ principalId: 'u1' });
    expect(plan.actions.map((a) => a.type)).toEqual([
      'mark_deactivated',
      'revoke_tokens',
      'destroy_sessions',
      'stop_instances',
      'delete_upstream_tokens',
    ]);
    expect(plan.actions.at(-1)).toMatchObject({ revokeAtUpstream: true });
    expect(plan.retained).toEqual(['call_log', 'audit_log']);
  });

  it('9.1 executes in order; best-effort cleanup failures are collected', async () => {
    const seen: string[] = [];
    const result = await executeDeactivation(planDeactivation({ principalId: 'u1' }), {
      execute: async (a: DeactivationAction) => {
        seen.push(a.type);
        if (a.type === 'stop_instances') throw new Error('runner down');
      },
    });
    expect(seen).toHaveLength(5);
    expect(result.errors).toEqual([{ action: 'stop_instances', message: 'runner down' }]);
  });

  it('9.1 a failing security-critical step aborts so it can be retried', async () => {
    const seen: string[] = [];
    await expect(
      executeDeactivation(planDeactivation({ principalId: 'u1' }), {
        execute: async (a) => {
          seen.push(a.type);
          if (a.type === 'revoke_tokens') throw new Error('redis down');
        },
      }),
    ).rejects.toThrow('redis down');
    expect(seen).toEqual(['mark_deactivated', 'revoke_tokens']);
  });
});

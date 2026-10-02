import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/audit';
import { getConfigVersion } from '../../src/config-version';
import {
  type ConfigEvent,
  createLocalAdminRepository,
  createPrincipalRepository,
  createProvisioningRepository,
  createRoleMappingRuleRepository,
  createScimStore,
  createTeamRepository,
  createUserRepository,
  etagOf,
  type ProvisioningPlan,
  type ScimFilterNode,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = { actorType: 'user', actorId: newId(), requestId: 'req-1' } as const;

const emptyPlan = (user: ProvisioningPlan['user']): ProvisioningPlan => ({
  user,
  createTeams: [],
  membershipUpserts: [],
  membershipRemovals: [],
  events: [],
  warnings: [],
});

describe.skipIf(!dbEnabled())('16.2 users, teams, memberships, SCIM and provisioning', () => {
  const h = useTestDb();

  it('17.1 users: create, case-insensitive lookup, ETag update, 412 on stale If-Match, audit in the same transaction', async () => {
    const events: ConfigEvent[] = [];
    const users = createUserRepository(h.db.prisma, { publishConfig: (e) => void events.push(e) });
    const u = await users.create({ email: 'Ada@Acme.com', displayName: 'Ada' }, { audit });
    expect(await users.findByEmail('ada@acme.com')).toMatchObject({ id: u.id });
    expect(events).toEqual([{ scope: 'user', id: u.id, version: 1n }]);

    const first = await users.getWithEtag(u.id);
    const updated = await users.update(
      u.id,
      { displayName: 'Ada L' },
      { ifMatch: first?.etag ?? '', audit },
    );
    expect(updated.displayName).toBe('Ada L');
    await expect(
      users.update(u.id, { displayName: 'stale' }, { ifMatch: first?.etag ?? '', audit }),
    ).rejects.toMatchObject({ httpStatus: 412 });
    await expect(users.update(u.id, { displayName: 'x' }, { ifMatch: '' })).rejects.toMatchObject({
      httpStatus: 428,
    });
    expect(await getConfigVersion(h.db.prisma, 'user', u.id)).toBe(2n);
    expect(await verifyAuditChain(h.db.prisma)).toMatchObject({ ok: true });
    await expect(users.create({ email: 'ADA@acme.com', displayName: 'dup' })).rejects.toMatchObject(
      { httpStatus: 409 },
    );
  });

  it('17.1 a failed mutation writes neither the audit event nor a config bump', async () => {
    const users = createUserRepository(h.db.prisma);
    const before = await h.db.prisma.auditEvent.count();
    await expect(
      users.update(newId(), { displayName: 'x' }, { ifMatch: '*', audit }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(await h.db.prisma.auditEvent.count()).toBe(before);
  });

  it('17.1 concurrent PATCHes with the same If-Match: exactly one wins, the others get 412', async () => {
    const users = createUserRepository(h.db.prisma);
    const u = await users.create({ email: 'race@acme.com', displayName: 'Race' });
    const etag = (await users.getWithEtag(u.id))?.etag ?? '';
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        users.update(u.id, { displayName: `n${i}` }, { ifMatch: etag }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ httpStatus: 412 });
    }
  });

  it('17.1 lists users with filters and keyset cursors; deletes with If-Match', async () => {
    const users = createUserRepository(h.db.prisma);
    for (let i = 0; i < 5; i++) {
      await users.create({ email: `page${i}@acme.com`, displayName: `Page ${i}` });
    }
    const first = await users.list({ q: 'page', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await users.list({ q: 'page', limit: 2, cursor: first.nextCursor ?? undefined });
    const third = await users.list({ q: 'page', limit: 2, cursor: second.nextCursor ?? undefined });
    const seen = [...first.items, ...second.items, ...third.items].map((x) => x.email);
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    expect((await users.list({ orgRole: 'admin' })).items).toHaveLength(0);
    expect(
      (await users.list({ status: 'active', orgRole: 'member', q: 'page0' })).items,
    ).toHaveLength(1);
    await expect(users.list({ cursor: 'garbage!' })).rejects.toMatchObject({ httpStatus: 400 });
    const victim = third.items[0];
    if (!victim) throw new Error('expected a user');
    await expect(users.delete(victim.id, { ifMatch: '"nope"' })).rejects.toMatchObject({
      httpStatus: 412,
    });
    await users.delete(victim.id, { ifMatch: '*', audit });
    expect(await users.get(victim.id)).toBeNull();
    await expect(users.delete(victim.id, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await users.count()).toBeGreaterThan(3);
    await users.recordLogin(first.items[0]?.id ?? '', new Date());
    await expect(users.recordLogin(newId(), new Date())).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('16.2 teams and memberships: slug order, member add/change/remove bump team and user versions', async () => {
    const teams = createTeamRepository(h.db.prisma);
    const users = createUserRepository(h.db.prisma);
    const u = await users.create({ email: 'member@acme.com', displayName: 'M' });
    const t = await teams.create({ slug: 'platform', displayName: 'Platform' }, { audit });
    await expect(teams.create({ slug: 'platform', displayName: 'again' })).rejects.toMatchObject({
      httpStatus: 409,
    });
    await expect(teams.create({ slug: 'Bad Slug', displayName: 'x' })).rejects.toMatchObject({
      httpStatus: 422,
    });
    await teams.setMembership({ teamId: t.id, userId: u.id, role: 'member' }, { audit });
    await teams.setMembership({ teamId: t.id, userId: u.id, role: 'manager' }, { audit });
    expect(await teams.listMembers(t.id)).toMatchObject([
      { userId: u.id, role: 'manager', source: 'manual' },
    ]);
    expect(await teams.listMembers(t.id, { source: 'scim' })).toEqual([]);
    expect(await teams.listForUser(u.id)).toHaveLength(1);
    expect((await teams.list({ userId: u.id })).items.map((x) => x.slug)).toEqual(['platform']);
    expect((await teams.list({ q: 'PLAT' })).items).toHaveLength(1);
    expect(await teams.getBySlug('platform')).toMatchObject({ id: t.id });
    expect(await teams.removeMembership(t.id, u.id, { audit })).toBe(true);
    expect(await teams.removeMembership(t.id, u.id)).toBe(false);
    const etag = (await teams.getWithEtag(t.id))?.etag ?? '';
    const renamed = await teams.update(t.id, { displayName: 'Platform Eng' }, { ifMatch: etag });
    expect(renamed.displayName).toBe('Platform Eng');
    await expect(
      teams.update(t.id, { displayName: 'late' }, { ifMatch: etag }),
    ).rejects.toMatchObject({ httpStatus: 412 });
    await expect(teams.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    await teams.delete(t.id, { ifMatch: (await teams.getWithEtag(t.id))?.etag ?? '', audit });
    expect(await teams.get(t.id)).toBeNull();
    await expect(teams.delete(t.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await getConfigVersion(h.db.prisma, 'team', t.id)).toBeGreaterThanOrEqual(5n);
  });

  it('9.1 role mapping rules are validated and ordered by priority', async () => {
    const rules = createRoleMappingRuleRepository(h.db.prisma);
    const a = await rules.create(
      { groupPattern: 'eng-.*', mapsTo: { createTeam: true }, priority: 20 },
      { audit },
    );
    await rules.create({ groupPattern: 'admins', mapsTo: { orgRole: 'admin' }, priority: 10 });
    expect((await rules.list(null)).map((r) => r.priority)).toEqual([10, 20]);
    expect((await rules.list()).length).toBe(2);
    await expect(
      rules.create({ groupPattern: 'x', mapsTo: { orgRole: 'root' } as never }),
    ).rejects.toThrow();
    const row = await h.db.prisma.roleMappingRule.findUniqueOrThrow({ where: { id: a.id } });
    const upd = await rules.update(
      a.id,
      { priority: 5, groupPattern: 'eng-.+', mapsTo: { teamId: newId(), teamRole: 'member' } },
      { ifMatch: etagOf(row), audit },
    );
    expect(upd.priority).toBe(5);
    await expect(
      rules.update(a.id, { priority: 1 }, { ifMatch: etagOf(row) }),
    ).rejects.toMatchObject({
      httpStatus: 412,
    });
    await expect(rules.update(newId(), {}, { ifMatch: '*' })).rejects.toMatchObject({
      httpStatus: 404,
    });
    const connection = newId();
    expect(await rules.list(connection)).toHaveLength(2);
    await rules.delete(a.id, { ifMatch: '*', audit });
    expect(await rules.get(a.id)).toBeNull();
    await expect(rules.delete(a.id, { ifMatch: '*' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('9.1 applyPlan creates teams, user and memberships atomically and reports onApplied after commit', async () => {
    const applied: string[] = [];
    const prov = createProvisioningRepository(h.db.prisma, {
      onApplied: (p) => void applied.push(p.user.id),
    });
    const teamId = newId();
    const userId = newId();
    await prov.applyPlan(
      {
        ...emptyPlan({
          kind: 'create',
          id: userId,
          email: 'jit@acme.com',
          displayName: 'Jit',
          orgRole: 'member',
          idpConnectionId: null,
          externalSubject: null,
        }),
        createTeams: [
          { id: teamId, slug: 'jit-team', displayName: 'Jit Team', idpGroup: 'Jit Team' },
        ],
        membershipUpserts: [{ teamId, userId, role: 'member', source: 'idp' }],
      },
      audit,
    );
    expect(applied).toEqual([userId]);
    const principals = createPrincipalRepository(h.db.prisma);
    expect(await principals.getPrincipal(userId)).toEqual({
      id: userId,
      type: 'user',
      orgRole: 'member',
      teams: [{ teamId, role: 'member' }],
      active: true,
    });

    // A unique violation rolls the whole plan back: the new team must not survive.
    const orphanTeam = newId();
    await expect(
      prov.applyPlan({
        ...emptyPlan({
          kind: 'create',
          id: newId(),
          email: 'JIT@acme.com',
          displayName: 'dup',
          orgRole: 'member',
          idpConnectionId: null,
          externalSubject: null,
        }),
        createTeams: [{ id: orphanTeam, slug: 'orphan', displayName: 'o', idpGroup: 'o' }],
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(await h.db.prisma.team.findUnique({ where: { id: orphanTeam } })).toBeNull();

    // Update: a login stamp is not a configuration change.
    const before = await getConfigVersion(h.db.prisma, 'user', userId);
    await prov.applyPlan(
      emptyPlan({ kind: 'update', id: userId, changes: { lastLoginAt: new Date() } }),
    );
    expect(await getConfigVersion(h.db.prisma, 'user', userId)).toBe(before);
    await prov.applyPlan(
      {
        ...emptyPlan({
          kind: 'update',
          id: userId,
          changes: {
            orgRole: 'auditor',
            status: 'deactivated',
            displayName: 'Jit 2',
            scimExternalId: 'x1',
          },
        }),
        membershipRemovals: [
          { teamId, userId },
          { teamId: newId(), userId },
        ],
      },
      audit,
    );
    expect(await principals.getPrincipal(userId)).toMatchObject({
      orgRole: 'auditor',
      active: false,
      teams: [],
    });
    expect(await principals.isUserActive(userId)).toBe(false);
    expect(await principals.isUserActive(newId())).toBe(false);
    await expect(
      prov.applyPlan(emptyPlan({ kind: 'update', id: newId(), changes: { displayName: 'ghost' } })),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await prov.applyPlan(emptyPlan({ kind: 'none', id: userId }));
  });

  it('9.1 service accounts resolve as members of their team through PrincipalStore and the directories', async () => {
    const teams = createTeamRepository(h.db.prisma);
    const t = await teams.create({ slug: 'bots', displayName: 'Bots' });
    const id = newId();
    await h.db.prisma.serviceAccount.create({
      data: { id, teamId: t.id, slug: 'ci', displayName: 'CI', oauthClientId: 'cl_ci' },
    });
    const principals = createPrincipalRepository(h.db.prisma);
    expect(await principals.getPrincipal(id)).toMatchObject({
      type: 'service',
      orgRole: 'member',
      teams: [{ teamId: t.id, role: 'member' }],
    });
    expect(await principals.serviceAccountForClient('cl_ci')).toEqual({ id });
    expect(await principals.serviceAccountForClient('nope')).toBeNull();
    expect(await principals.find({ kind: 'service', id })).toMatchObject({
      team: { id: t.id, slug: 'bots' },
    });
    await h.db.prisma.serviceAccount.update({ where: { id }, data: { status: 'disabled' } });
    expect(await principals.serviceAccountForClient('cl_ci')).toBeNull();
    expect(await principals.getPrincipal(id)).toMatchObject({ active: false });
    expect(await principals.getPrincipal(newId())).toBeNull();
    expect(await principals.find({ kind: 'user', id: newId() })).toBeNull();
    expect(await principals.find({ kind: 'service', id: newId() })).toBeNull();
  });

  it('policy PrincipalDirectory.find builds the user principal with team slugs and email domain', async () => {
    const users = createUserRepository(h.db.prisma);
    const teams = createTeamRepository(h.db.prisma);
    const u = await users.create({
      email: 'dir@Corp.example',
      displayName: 'Dir',
      orgRole: 'auditor',
    });
    const t = await teams.create({ slug: 'dir-team', displayName: 'D' });
    await teams.setMembership({ teamId: t.id, userId: u.id, role: 'manager' });
    expect(await createPrincipalRepository(h.db.prisma).find({ kind: 'user', id: u.id })).toEqual({
      kind: 'user',
      id: u.id,
      role: 'auditor',
      active: true,
      emailDomain: 'corp.example',
      teams: [{ id: t.id, slug: 'dir-team', role: 'manager' }],
    });
  });

  it('9.1 local admin: create and find by email', async () => {
    const repo = createLocalAdminRepository(h.db.prisma);
    const id = newId();
    await repo.createLocalAdmin({
      id,
      email: 'root@acme.com',
      displayName: 'Administrator',
      passwordHash: 'hash',
    });
    expect(await repo.findByEmail('ROOT@acme.com')).toEqual({
      id,
      email: 'root@acme.com',
      orgRole: 'admin',
      status: 'active',
      localPasswordHash: 'hash',
    });
    expect(await repo.findByEmail('missing@acme.com')).toBeNull();
    await expect(
      repo.createLocalAdmin({
        id: newId(),
        email: 'root@acme.com',
        displayName: 'x',
        passwordHash: 'h',
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('9.1 local admin: set a new password hash, with or without an audit event', async () => {
    const repo = createLocalAdminRepository(h.db.prisma);
    const id = newId();
    await repo.createLocalAdmin({
      id,
      email: 'pw@acme.com',
      displayName: 'Administrator',
      passwordHash: 'hash-1',
    });
    expect(await repo.findById(id)).toMatchObject({ id, localPasswordHash: 'hash-1' });
    expect(await repo.findById(newId())).toBeNull();
    await repo.setPasswordHash({
      userId: id,
      passwordHash: 'hash-2',
      audit: { action: 'user.password_reset', actorType: 'system' },
    });
    expect((await repo.findById(id))?.localPasswordHash).toBe('hash-2');
    await repo.setPasswordHash({ userId: id, passwordHash: 'hash-3' });
    expect((await repo.findById(id))?.localPasswordHash).toBe('hash-3');
    const events = await h.db.prisma.auditEvent.findMany({
      where: { targetId: id, action: { startsWith: 'user.password' } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'user.password_reset', actorType: 'system' });
    expect(JSON.stringify(events[0]?.diff)).not.toContain('hash');
    await expect(
      repo.setPasswordHash({ userId: newId(), passwordHash: 'x' }),
    ).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  describe('9.1 SCIM store', () => {
    class Conflict extends Error {}
    const scoped = (right: ScimFilterNode): ScimFilterNode => ({
      op: 'and',
      left: { op: 'co', attr: 'userName', value: '@scim.test' },
      right,
    });
    const scim = () => createScimStore(h.db.prisma, { conflictError: (m) => new Conflict(m) });

    it('lists users with filters, hides local admins, pages by startIndex/count', async () => {
      const store = scim();
      const prov = createProvisioningRepository(h.db.prisma);
      const ids: string[] = [];
      for (const [i, name] of ['ann', 'bob', 'cy'].entries()) {
        const id = newId();
        ids.push(id);
        await prov.applyPlan(
          emptyPlan({
            kind: 'create',
            id,
            email: `${name}@scim.test`,
            displayName: name.toUpperCase(),
            orgRole: 'member',
            idpConnectionId: null,
            externalSubject: null,
            scimExternalId: `ext-${i}`,
          }),
        );
      }
      const all = await store.listUsers({
        filter: { op: 'co', attr: 'userName', value: '@scim.test' },
        startIndex: 1,
        count: 2,
      });
      expect(all.total).toBe(3);
      expect(all.items).toHaveLength(2);
      const page2 = await store.listUsers({
        filter: { op: 'co', attr: 'userName', value: '@SCIM.test' },
        startIndex: 3,
        count: 2,
      });
      expect(page2.items).toHaveLength(1);
      const eq = await store.listUsers({
        filter: { op: 'eq', attr: 'externalId', value: 'ext-1' },
        startIndex: 1,
        count: 10,
      });
      expect(eq.items.map((u) => u.userName)).toEqual(['bob@scim.test']);
      expect(eq.items[0]).toMatchObject({ externalId: 'ext-1', active: true, displayName: 'BOB' });
      const combos = await store.listUsers({
        filter: {
          op: 'and',
          left: { op: 'sw', attr: 'userName', value: 'ann@' },
          right: { op: 'not', operand: { op: 'eq', attr: 'active', value: false } },
        },
        startIndex: 1,
        count: 10,
      });
      expect(combos.items.map((u) => u.userName)).toEqual(['ann@scim.test']);
      const either = await store.listUsers({
        filter: {
          op: 'or',
          left: { op: 'ew', attr: 'displayName', value: 'Y' },
          right: { op: 'pr', attr: 'externalId' },
        },
        startIndex: 1,
        count: 10,
      });
      expect(either.items.filter((u) => u.userName.endsWith('@scim.test'))).toHaveLength(3);
      const inactive = await store.listUsers({
        filter: scoped({ op: 'ne', attr: 'active', value: true }),
        startIndex: 1,
        count: 10,
      });
      expect(inactive.total).toBe(0);
      const badBool = await store.listUsers({
        filter: scoped({ op: 'eq', attr: 'active', value: 'yes' }),
        startIndex: 1,
        count: 10,
      });
      expect(badBool.total).toBe(0);
      const presentActive = await store.listUsers({
        filter: scoped({ op: 'pr', attr: 'active' }),
        startIndex: 1,
        count: 10,
      });
      expect(presentActive.total).toBe(3);
      const unknownAttr = await store.listUsers({
        filter: { op: 'eq', attr: 'nickName', value: 'z' },
        startIndex: 1,
        count: 10,
      });
      expect(unknownAttr.total).toBe(0);
      const unknownNe = await store.listUsers({
        filter: scoped({ op: 'ne', attr: 'nickName', value: 'z' }),
        startIndex: 1,
        count: 10,
      });
      expect(unknownNe.total).toBe(3);
      const ne = await store.listUsers({
        filter: { op: 'ne', attr: 'id', value: ids[0] ?? '' },
        startIndex: 1,
        count: 10,
      });
      expect(ne.items.some((u) => u.id === ids[0])).toBe(false);
      expect(await store.getUser(ids[0] ?? '')).toMatchObject({ userName: 'ann@scim.test' });
      expect(await store.findUserIdByEmail('ANN@scim.test')).toBe(ids[0]);
      expect(await store.findUserIdByEmail('nobody@scim.test')).toBeNull();
      expect(await store.getUserState(ids[0] ?? '')).toMatchObject({
        isLocal: false,
        memberships: [],
      });
      expect(await store.getUserState(newId())).toBeNull();
      const admins = createLocalAdminRepository(h.db.prisma);
      const adminId = newId();
      await admins.createLocalAdmin({
        id: adminId,
        email: 'breakglass@scim.test',
        displayName: 'A',
        passwordHash: 'h',
      });
      expect(await store.getUser(adminId)).toBeNull();
    });

    it('groups: create through a plan, scim membership, rename, detach; conflicts raise the injected error', async () => {
      const store = scim();
      const teamId = newId();
      const userId = newId();
      await store.applyPlans([
        {
          ...emptyPlan({
            kind: 'create',
            id: userId,
            email: 'grp@scim.test',
            displayName: 'Grp',
            orgRole: 'member',
            idpConnectionId: null,
            externalSubject: null,
          }),
          createTeams: [
            { id: teamId, slug: 'eng', displayName: 'Engineers', idpGroup: 'Engineers' },
          ],
          membershipUpserts: [{ teamId, userId, role: 'member', source: 'scim' }],
        },
      ]);
      expect(await store.getGroup(teamId)).toMatchObject({
        displayName: 'Engineers',
        members: [{ id: userId, display: 'Grp' }],
      });
      expect(await store.findGroupByName('Engineers')).toMatchObject({ id: teamId });
      expect(await store.findGroupByName('Nope')).toBeNull();
      expect(
        (
          await store.listGroups({
            filter: { op: 'eq', attr: 'displayName', value: 'engineers' },
            startIndex: 1,
            count: 5,
          })
        ).total,
      ).toBe(1);
      expect(
        (await store.listGroups({ filter: null, startIndex: 1, count: 50 })).items.map((g) => g.id),
      ).toContain(teamId);
      expect(await store.userScimGroups(userId)).toEqual([{ teamId, name: 'Engineers' }]);
      expect(await store.listTeamRefs()).toContainEqual({
        id: teamId,
        slug: 'eng',
        idpGroup: 'Engineers',
      });
      await store.renameGroup(teamId, 'Engineering');
      expect(await store.getGroup(teamId)).toMatchObject({ displayName: 'Engineering' });
      expect(await store.userScimGroups(userId)).toEqual([{ teamId, name: 'Engineering' }]);
      await expect(
        store.applyPlans([
          {
            ...emptyPlan({ kind: 'none', id: newId() }),
            createTeams: [{ id: newId(), slug: 'eng', displayName: 'dup', idpGroup: 'dup' }],
          },
        ]),
      ).rejects.toBeInstanceOf(Conflict);
      await createRoleMappingRuleRepository(h.db.prisma).create({
        groupPattern: 'g',
        mapsTo: { orgRole: 'auditor' },
      });
      expect((await store.listRules(null)).length).toBeGreaterThan(0);
      expect((await store.listRules(newId())).length).toBeGreaterThan(0);
      await store.detachGroup(teamId);
      expect(await store.getGroup(teamId)).toBeNull();
      await store.detachGroup(teamId);
      await store.renameGroup(newId(), 'nothing');
    });
  });

  it('17.1 concurrent membership changes keep config versions exact and the audit chain valid', async () => {
    const teams = createTeamRepository(h.db.prisma);
    const users = createUserRepository(h.db.prisma);
    const t = await teams.create({ slug: 'concurrent', displayName: 'C' });
    const us = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        users.create({ email: `c${i}@acme.com`, displayName: `C${i}` }),
      ),
    );
    const base = await getConfigVersion(h.db.prisma, 'team', t.id);
    await Promise.all(
      us.map((u) => teams.setMembership({ teamId: t.id, userId: u.id, role: 'member' }, { audit })),
    );
    expect(await getConfigVersion(h.db.prisma, 'team', t.id)).toBe(base + 6n);
    expect(await verifyAuditChain(h.db.prisma)).toMatchObject({ ok: true });
  });
});

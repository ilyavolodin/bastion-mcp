import { afterEach, describe, expect, it } from 'vitest';
import { computePreview, type PreviewData, type PreviewPolicy } from '../src/services/auto-install';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt: 'x', ...extra });

/** 6 teams x ~70 users, 38 of which need to connect: the 11.5 example shape. */
const synthetic = (): { policy: PreviewPolicy; data: PreviewData } => {
  const users = Array.from({ length: 412 }, (_, i) =>
    row(`u${i}`, { orgRole: 'member', displayName: `U${i}` }),
  );
  const teams = Array.from({ length: 6 }, (_, i) => row(`t${i}`, { slug: `team-${i}` }));
  const memberships = users.map((u, i) =>
    row(`m${i}`, { teamId: `t${i % 6}`, userId: u.id, role: 'member' }),
  );
  return {
    policy: {
      id: 'p',
      catalogEntryId: 'e',
      target: { all: true },
      mode: 'default',
      scope: 'user',
      applyToExisting: true,
    },
    data: {
      users,
      memberships,
      teams,
      installations: [],
      applications: [],
      needsPerUserSetup: true,
    },
  };
};

describe('11.5 auto-install preview (pure)', () => {
  it('11.5 counts people, teams and who must connect: "412 people in 6 teams"', () => {
    const { policy, data } = synthetic();
    const out = computePreview(policy, data);
    expect(out).toMatchObject({ users: 412, teams: 6, willInstall: 412, mustConnect: 412 });
    expect(out.summary).toBe('412 people in 6 teams get this; 412 must connect their account');
    expect(out.byTeam).toHaveLength(6);
    expect(out.sample).toHaveLength(20);
  });

  it('11.5 skips users who already have it and removed `default` installs, but not `required`', () => {
    const { policy, data } = synthetic();
    const withInstalls: PreviewData = {
      ...data,
      installations: [row('i1', { catalogEntryId: 'e', ownerType: 'user', ownerId: 'u0' })],
      applications: [
        row('a1', { policyId: 'p', subjectType: 'user', subjectId: 'u1', result: 'removed' }),
      ],
    };
    const def = computePreview(policy, withInstalls);
    expect(def).toMatchObject({ willInstall: 410, alreadyInstalled: 1, skippedRemoved: 1 });
    const req = computePreview({ ...policy, mode: 'required' }, withInstalls);
    expect(req).toMatchObject({ willInstall: 411, alreadyInstalled: 1, skippedRemoved: 0 });
  });

  it('11.5 matches by team, role (including manager), IdP group and ignores deactivated users', () => {
    const data: PreviewData = {
      users: [
        row('a', { orgRole: 'admin' }),
        row('b', { orgRole: 'member', idpGroups: ['eng'] }),
        row('c', { orgRole: 'member', status: 'deactivated' }),
        row('d', { orgRole: 'member' }),
      ],
      memberships: [
        row('m1', { teamId: 't1', userId: 'd', role: 'manager' }),
        row('m2', { teamId: 't1', userId: 'c', role: 'member' }),
      ],
      teams: [row('t1', { slug: 'one' })],
      installations: [],
      applications: [],
      needsPerUserSetup: false,
    };
    const base = {
      id: 'p',
      catalogEntryId: 'e',
      mode: 'default',
      scope: 'user',
      applyToExisting: true,
    };
    expect(computePreview({ ...base, target: { roles: ['admin'] } }, data).users).toBe(1);
    expect(computePreview({ ...base, target: { roles: ['manager'] } }, data).users).toBe(1);
    expect(computePreview({ ...base, target: { idpGroups: ['eng'] } }, data).users).toBe(1);
    expect(computePreview({ ...base, target: { teamIds: ['t1'] } }, data).users).toBe(1);
    expect(computePreview({ ...base, target: { all: true } }, data)).toMatchObject({
      users: 3,
      mustConnect: 0,
    });
    expect(computePreview({ ...base, target: { all: true } }, data).summary).toBe(
      '3 people in 1 team get this',
    );
  });

  it('11.5 team scope installs once per target team and honors existing team installations', () => {
    const { policy, data } = synthetic();
    const out = computePreview(
      { ...policy, scope: 'team', target: { teamIds: ['t0', 't1'] } },
      {
        ...data,
        installations: [row('i', { catalogEntryId: 'e', ownerType: 'team', ownerId: 't0' })],
      },
    );
    expect(out).toMatchObject({ willInstall: 1, alreadyInstalled: 1, mustConnect: 0 });
  });

  it('11.5 applyToExisting=false leaves existing users out', () => {
    const { policy, data } = synthetic();
    const out = computePreview({ ...policy, applyToExisting: false }, data);
    expect(out).toMatchObject({ willInstall: 0, users: 412 });
  });
});

describe('11.5 auto-install policies (routes)', () => {
  it('11.5 lists policies for admins, managers and auditors but not members', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'GET', '/auto-install-policies')).status).toBe(200);
    expect((await api.call('managerOwn', 'GET', '/auto-install-policies')).status).toBe(200);
    expect((await api.call('member', 'GET', '/auto-install-policies')).status).toBe(403);
  });

  it('10.1 a manager creates a policy that targets only their team; org-wide ones need an admin', async () => {
    api = await buildTestApi();
    const body = (target: unknown) => ({ catalogEntryId: 'entry-i-pub', target, mode: 'default' });
    const ok = await api.call('managerOwn', 'POST', '/auto-install-policies', {
      body: body({ teamIds: ['team-a'] }),
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      scope: 'user',
      applyToExisting: true,
      createdBy: 'user-manager-a',
    });
    expect(api.uow.audits.at(-1)?.action).toBe('auto_install_policy.create');
    expect(
      (
        await api.call('managerOwn', 'POST', '/auto-install-policies', {
          body: body({ teamIds: ['team-b'] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call('managerOwn', 'POST', '/auto-install-policies', {
          body: body({ all: true }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call('managerOwn', 'POST', '/auto-install-policies', {
          body: body({ teamIds: ['team-a', 'team-b'] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call('admin', 'POST', '/auto-install-policies', {
          body: body({ roles: ['member'] }),
        })
      ).status,
    ).toBe(201);
  });

  it('11.5 only published entries and valid targets are accepted', async () => {
    api = await buildTestApi();
    const draft = await api.call('admin', 'POST', '/auto-install-policies', {
      body: { catalogEntryId: 'entry-i-draft', target: { all: true } },
    });
    expect(draft.status).toBe(409);
    expect(rec(draft.body).code).toBe('entry_not_published');
    expect(
      (
        await api.call('admin', 'POST', '/auto-install-policies', {
          body: { catalogEntryId: 'nope', target: { all: true } },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.call('admin', 'POST', '/auto-install-policies', {
          body: { catalogEntryId: 'entry-org', target: {} },
        })
      ).status,
    ).toBe(400);
  });

  it('10.1 PATCH and DELETE authorize on the stored target; a manager cannot widen a policy', async () => {
    api = await buildTestApi();
    const get = await api.call('admin', 'GET', '/auto-install-policies');
    expect(get.status).toBe(200);
    const row = await api.store.get('auto_install_policies', 'aip-team-a');
    const ifMatch = `"${row?.updatedAt}"`;
    const widen = await api.call('managerOwn', 'PATCH', '/auto-install-policies/aip-team-a', {
      headers: { 'if-match': ifMatch },
      body: { target: { all: true } },
    });
    expect(widen.status).toBe(403);
    const ok = await api.call('managerOwn', 'PATCH', '/auto-install-policies/aip-team-a', {
      headers: { 'if-match': ifMatch },
      body: { mode: 'required', enabled: false },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: 'required', enabled: false });
    const orgRow = await api.store.get('auto_install_policies', 'aip-org');
    expect(
      (
        await api.call('managerOwn', 'PATCH', '/auto-install-policies/aip-org', {
          headers: { 'if-match': `"${orgRow?.updatedAt}"` },
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api.call('managerOther', 'DELETE', '/auto-install-policies/aip-team-a')).status,
    ).toBe(403);
    const del = await api.call('admin', 'DELETE', '/auto-install-policies/aip-org', {
      headers: { 'if-match': `"${orgRow?.updatedAt}"` },
    });
    expect(del.status).toBe(204);
  });

  it('11.5 preview computes who would get what from the stored policy and unsaved overrides', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'POST', '/auto-install-policies/aip-team-a/preview', {
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ users: 2, teams: 1, willInstall: 2, mustConnect: 2 });
    expect(rec(res.body).summary).toBe('2 people in 1 team get this; 2 must connect their account');
    const unsaved = await api.call('admin', 'POST', '/auto-install-policies/aip-org/preview', {
      body: { scope: 'team', target: { teamIds: ['team-a', 'team-b'] } },
    });
    expect(unsaved.body).toMatchObject({ willInstall: 2, mustConnect: 0 });
    expect(api.uow.audits).toHaveLength(0);
  });

  it('11.5 preview excludes people who already have it and previously removed defaults', async () => {
    api = await buildTestApi();
    await api.store.seed('installations', {
      id: 'inst-pub',
      ownerType: 'user',
      ownerId: 'user-member-a',
      catalogEntryId: 'entry-i-pub',
      slug: 'pub',
    });
    await api.store.seed('auto_install_applications', {
      id: 'app-1',
      policyId: 'aip-team-a',
      subjectType: 'user',
      subjectId: 'user-manager-a',
      result: 'removed',
    });
    const res = await api.call('admin', 'POST', '/auto-install-policies/aip-team-a/preview', {
      body: {},
    });
    expect(res.body).toMatchObject({
      users: 2,
      alreadyInstalled: 1,
      skippedRemoved: 1,
      willInstall: 0,
    });
  });

  it('10.1 preview is denied for other teams managers and unknown policies look forbidden', async () => {
    api = await buildTestApi();
    expect(
      (
        await api.call('managerOther', 'POST', '/auto-install-policies/aip-team-a/preview', {
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await api.call('managerOwn', 'POST', '/auto-install-policies/nope/preview', { body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await api.call('admin', 'POST', '/auto-install-policies/nope/preview', { body: {} })).status,
    ).toBe(404);
  });
});

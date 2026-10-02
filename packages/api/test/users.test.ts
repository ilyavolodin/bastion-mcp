import type { DeactivationAction } from '@bastion-mcp/auth';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const items = (v: unknown): Array<Record<string, unknown>> =>
  rec(v).items as Array<Record<string, unknown>>;
const ifMatch = async (t: TestApi, url: string): Promise<{ 'if-match': string }> => {
  const res = await t.call('admin', 'GET', url);
  return { 'if-match': String(res.headers.etag) };
};

describe('17.2 users', () => {
  it('17.2 lists users and filters by status and role', async () => {
    api = await buildTestApi();
    const all = await api.call('admin', 'GET', '/users');
    expect(items(all.body)).toHaveLength(6);
    const auditors = await api.call('admin', 'GET', '/users', { query: { orgRole: 'auditor' } });
    expect(items(auditors.body).map((u) => u.id)).toEqual([W.auditor]);
    const none = await api.call('admin', 'GET', '/users', { query: { status: 'deactivated' } });
    expect(items(none.body)).toHaveLength(0);
  });

  it('17.2 creates a user with the member role by default and audits it', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', {
      body: { email: 'new@example.com', displayName: 'New' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      orgRole: 'member',
      status: 'active',
      email: 'new@example.com',
    });
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'user.create', targetType: 'user' });
    const dup = await api.call('admin', 'POST', '/users', {
      body: { email: 'new@example.com', displayName: 'Again' },
    });
    expect(dup.status).toBe(409);
  });

  it('17.2 gets one user and answers 404 for an unknown id', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'GET', `/users/${W.memberA}`)).status).toBe(200);
    expect((await api.call('admin', 'GET', '/users/ghost')).status).toBe(404);
  });

  it('10.1 only admins change roles; managers and auditors cannot', async () => {
    api = await buildTestApi();
    const headers = await ifMatch(api, `/users/${W.memberA}`);
    const denied = await api.call('managerOwn', 'PATCH', `/users/${W.memberA}`, {
      headers,
      body: { orgRole: 'admin' },
    });
    expect(denied.status).toBe(403);
    const ok = await api.call('admin', 'PATCH', `/users/${W.memberA}`, {
      headers,
      body: { orgRole: 'auditor' },
    });
    expect(ok.status).toBe(200);
    expect(rec(ok.body).orgRole).toBe('auditor');
    const empty = await api.call('admin', 'PATCH', `/users/${W.memberA}`, {
      headers: { 'if-match': String(ok.headers.etag) },
      body: {},
    });
    expect(empty.status).toBe(400);
  });

  it('9.1 deactivation marks the user, then revokes tokens and sessions and stops instances after commit', async () => {
    const executed: DeactivationAction['type'][] = [];
    api = await buildTestApi({
      overrides: { deactivation: { execute: async (a) => void executed.push(a.type) } },
    });
    const res = await api.call('admin', 'POST', `/users/${W.memberB}/deactivate`);
    expect(res.status).toBe(200);
    expect(rec(res.body).status).toBe('deactivated');
    expect(executed).toEqual([
      'revoke_tokens',
      'destroy_sessions',
      'stop_instances',
      'delete_upstream_tokens',
    ]);
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'user.deactivate', targetId: W.memberB });
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"users"}');
  });

  it('9.1 deactivating an already deactivated user changes nothing, and you cannot deactivate yourself', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', `/users/${W.memberB}/deactivate`);
    const audits = api.uow.audits.length;
    const again = await api.call('admin', 'POST', `/users/${W.memberB}/deactivate`);
    expect(again.status).toBe(200);
    expect(api.uow.audits).toHaveLength(audits + 1);
    expect(api.uow.audits.at(-1)?.diff).toEqual({ noop: true });
    const self = await api.call('admin', 'POST', `/users/${W.admin}/deactivate`);
    expect(self.status).toBe(409);
    expect(rec(self.body).code).toBe('cannot_deactivate_self');
  });
});

describe('17.2 teams and members', () => {
  it('17.2 creates, reads (with members), updates and deletes a team', async () => {
    api = await buildTestApi();
    const created = await api.call('admin', 'POST', '/teams', {
      body: { slug: 'platform', displayName: 'Platform' },
    });
    expect(created.status).toBe(201);
    const id = String(rec(created.body).id);
    const got = await api.call('admin', 'GET', `/teams/${id}`);
    expect(rec(got.body).members).toEqual([]);
    const patched = await api.call('admin', 'PATCH', `/teams/${id}`, {
      headers: { 'if-match': String(got.headers.etag) },
      body: { displayName: 'Platform Eng' },
    });
    expect(rec(patched.body).displayName).toBe('Platform Eng');
    const del = await api.call('admin', 'DELETE', `/teams/${id}`, {
      headers: { 'if-match': String(patched.headers.etag) },
    });
    expect(del.status).toBe(204);
    expect((await api.call('admin', 'GET', `/teams/${id}`)).status).toBe(404);
  });

  it('17.2 rejects invalid and duplicate slugs', async () => {
    api = await buildTestApi();
    const bad = await api.call('admin', 'POST', '/teams', {
      body: { slug: 'Not A Slug', displayName: 'X' },
    });
    expect(bad.status).toBe(400);
    const dup = await api.call('admin', 'POST', '/teams', {
      body: { slug: 'team-a', displayName: 'X' },
    });
    expect(dup.status).toBe(409);
  });

  it('17.2 deleting a team removes its memberships in the same transaction', async () => {
    api = await buildTestApi();
    const headers = await ifMatch(api, `/teams/${W.teamB}`);
    const res = await api.call('admin', 'DELETE', `/teams/${W.teamB}`, { headers });
    expect(res.status).toBe(204);
    expect(await api.store.find('team_members', { teamId: W.teamB })).toHaveLength(0);
  });

  it('17.2 returns the members of a team with the team', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'GET', `/teams/${W.teamA}`);
    expect(res.status).toBe(200);
    const members = rec(res.body).members as Array<Record<string, unknown>>;
    expect(members.map((m) => m.userId).sort()).toEqual([W.managerA, W.memberA].sort());
  });

  it('10.1 managers see and manage only their own team', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOwn', 'GET', `/teams/${W.teamA}`)).status).toBe(200);
    expect((await api.call('managerOwn', 'GET', `/teams/${W.teamB}`)).status).toBe(403);
    const add = await api.call('managerOwn', 'PUT', `/teams/${W.teamA}/members/${W.memberB}`, {
      body: { role: 'member' },
    });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ teamId: W.teamA, userId: W.memberB, role: 'member' });
    const foreign = await api.call('managerOwn', 'PUT', `/teams/${W.teamB}/members/${W.memberA}`, {
      body: { role: 'member' },
    });
    expect(foreign.status).toBe(403);
  });

  it('17.2 changes a member role with If-Match, and removes the member', async () => {
    api = await buildTestApi();
    const url = `/teams/${W.teamA}/members/${W.memberA}`;
    const row = await api.store.get('team_members', `${W.teamA}:${W.memberA}`);
    const promoted = await api.call('admin', 'PUT', url, {
      headers: { 'if-match': `"${row?.updatedAt}"` },
      body: { role: 'manager' },
    });
    expect(promoted.status).toBe(200);
    expect(rec(promoted.body).role).toBe('manager');
    const removed = await api.call('admin', 'DELETE', url, {
      headers: { 'if-match': String(promoted.headers.etag) },
    });
    expect(removed.status).toBe(204);
    expect(api.uow.audits.map((a) => a.action)).toEqual(['team.member.set', 'team.member.remove']);
    const missing = await api.call('admin', 'DELETE', url);
    expect(missing.status).toBe(404);
  });

  it('17.2 refuses members for unknown teams or users', async () => {
    api = await buildTestApi();
    const noTeam = await api.call('admin', 'PUT', `/teams/ghost/members/${W.memberA}`, {
      body: { role: 'member' },
    });
    expect(noTeam.status).toBe(404);
    const noUser = await api.call('admin', 'PUT', `/teams/${W.teamA}/members/ghost`, {
      body: { role: 'member' },
    });
    expect(noUser.status).toBe(404);
  });
});

describe('17.2 role-mapping rules (9.1)', () => {
  const body = {
    groupPattern: 'eng-.*',
    mapsTo: { teamId: W.teamA, teamRole: 'member' },
    priority: 10,
  };

  it('9.1 creates, lists, updates and deletes a rule', async () => {
    api = await buildTestApi();
    const created = await api.call('admin', 'POST', '/role-mapping-rules', { body });
    expect(created.status).toBe(201);
    const id = String(rec(created.body).id);
    const list = await api.call('admin', 'GET', '/role-mapping-rules');
    expect(items(list.body)).toHaveLength(1);
    const patched = await api.call('admin', 'PATCH', `/role-mapping-rules/${id}`, {
      headers: { 'if-match': String(created.headers.etag) },
      body: { priority: 5 },
    });
    expect(rec(patched.body).priority).toBe(5);
    const del = await api.call('admin', 'DELETE', `/role-mapping-rules/${id}`, {
      headers: { 'if-match': String(patched.headers.etag) },
    });
    expect(del.status).toBe(204);
  });

  it('9.1 rejects a pattern that is not valid RE2 and a malformed target', async () => {
    api = await buildTestApi();
    const bad = await api.call('admin', 'POST', '/role-mapping-rules', {
      body: { ...body, groupPattern: '(?<=x)y' },
    });
    expect(bad.status).toBe(400);
    const worse = await api.call('admin', 'POST', '/role-mapping-rules', {
      body: { ...body, mapsTo: { orgRole: 'root' } },
    });
    expect(worse.status).toBe(400);
    const patch = await api.call('admin', 'PATCH', '/role-mapping-rules/x', {
      headers: { 'if-match': '*' },
      body: { groupPattern: '(' },
    });
    expect([400, 404]).toContain(patch.status);
  });
});

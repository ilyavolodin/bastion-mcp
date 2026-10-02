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

describe('17.2 GET /me and PATCH /me', () => {
  it('17.2 returns the caller with role, resolved teams and token scopes', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'GET', '/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: W.managerA,
      type: 'user',
      orgRole: 'member',
      authMethod: 'pat',
      email: 'manager-a@example.com',
      teams: [{ teamId: W.teamA, role: 'manager', slug: 'team-a', displayName: 'Team A' }],
    });
    expect(rec(res.body).scopes).toEqual(['api:read', 'api:write']);
    expect(res.headers.etag).toBeDefined();
  });

  it('17.2 returns org display data and the Cedar-derived capabilities the console needs', async () => {
    api = await buildTestApi();
    const admin = await api.call('admin', 'GET', '/me');
    expect(admin.body).toMatchObject({
      org: { name: expect.any(String), host: expect.any(String), toolWarnThreshold: 40 },
      capabilities: { registry: true, publishOrgWide: true, personalInstalls: 'remoteOnly' },
    });
    expect(rec(rec(admin.body).org).traceUiUrl).toBeNull();
    const auditor = await api.call('auditor', 'GET', '/me');
    expect(rec(auditor.body).capabilities).toMatchObject({
      registry: false,
      publishOrgWide: false,
    });
  });

  it('17.2 returns a service account as itself', async () => {
    api = await buildTestApi();
    const res = await api.call('service', 'GET', '/me');
    expect(res.body).toMatchObject({ id: W.svc, type: 'service', displayName: 'CI' });
  });

  it('17.2 lets a user change only their display name, with If-Match', async () => {
    api = await buildTestApi();
    const me = await api.call('member', 'GET', '/me');
    const missing = await api.call('member', 'PATCH', '/me', { body: { displayName: 'Ann' } });
    expect(missing.status).toBe(428);
    const res = await api.call('member', 'PATCH', '/me', {
      headers: { 'if-match': String(me.headers.etag) },
      body: { displayName: 'Ann' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).displayName).toBe('Ann');
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'user.update_self', actorId: W.memberA });
    const role = await api.call('member', 'PATCH', '/me', {
      headers: { 'if-match': String(res.headers.etag) },
      body: { orgRole: 'admin' },
    });
    expect(role.status).toBe(200);
    expect(rec(role.body).orgRole).toBe('member');
  });

  it('17.2 does not let a service account use PATCH /me', async () => {
    api = await buildTestApi();
    const me = await api.call('service', 'GET', '/me');
    const res = await api.call('service', 'PATCH', '/me', {
      headers: { 'if-match': String(me.headers.etag) },
      body: { displayName: 'x' },
    });
    expect(res.status).toBe(422);
  });
});

describe('17.2 notifications', () => {
  const seed = async (t: TestApi) => {
    await t.store.seed('notifications', {
      id: 'n-1',
      userId: W.memberA,
      kind: 'install_request_decided',
      createdAt: '2026-01-02T00:00:00.000Z',
      readAt: null,
    });
    await t.store.seed('notifications', {
      id: 'n-2',
      userId: W.memberA,
      kind: 'drift',
      createdAt: '2026-01-03T00:00:00.000Z',
      readAt: '2026-01-04T00:00:00.000Z',
    });
    await t.store.seed('notifications', {
      id: 'n-3',
      userId: W.memberB,
      kind: 'drift',
      createdAt: '2026-01-03T00:00:00.000Z',
      readAt: null,
    });
  };

  it('17.2 lists only your notifications, newest first, and filters unread', async () => {
    api = await buildTestApi();
    await seed(api);
    const all = await api.call('member', 'GET', '/me/notifications');
    expect(items(all.body).map((n) => n.id)).toEqual(['n-2', 'n-1']);
    const unread = await api.call('member', 'GET', '/me/notifications', {
      query: { unread: 'true' },
    });
    expect(items(unread.body).map((n) => n.id)).toEqual(['n-1']);
  });

  it('17.2 marks a notification read and refuses someone else’s', async () => {
    api = await buildTestApi();
    await seed(api);
    const res = await api.call('member', 'POST', '/me/notifications/n-1/read');
    expect(res.status).toBe(200);
    expect(rec(res.body).readAt).toBe('2026-06-01T12:00:00.000Z');
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'notification.read', targetId: 'n-1' });
    const foreign = await api.call('member', 'POST', '/me/notifications/n-3/read');
    expect(foreign.status).toBe(404);
  });
});

describe('17.2 GET /me/quotas (14)', () => {
  it('14 reports usage of the rules that apply to the caller', async () => {
    api = await buildTestApi({
      overrides: {
        limits: {
          readUsage: async (rule, subjectId) => ({
            ruleId: rule.id,
            kind: rule.kind,
            subjectId,
            limit: 100,
            consumed: 40,
            remaining: 60,
            resetsAt: '2026-06-02T00:00:00.000Z',
          }),
        },
      },
    });
    for (const row of await api.store.find('limit_rules', {})) {
      await api.store.remove('limit_rules', row.id);
    }
    await api.store.seed('limit_rules', {
      id: 'rule-user-quota',
      name: 'Daily calls',
      kind: 'quota',
      subject: 'user',
      subjectMatch: 'each',
      metric: 'calls',
      params: { points: 100, period: 'day' },
    });
    await api.store.seed('limit_rules', {
      id: 'rule-team',
      name: 'Team rate',
      kind: 'rate',
      subject: 'team',
      params: { points: 10, perSeconds: 1, burst: 0 },
    });
    await api.store.seed('limit_rules', {
      id: 'rule-other-team',
      name: 'Other team',
      kind: 'rate',
      subject: 'team',
      subjectMatch: [W.teamB],
      params: { points: 10, perSeconds: 1, burst: 0 },
    });
    await api.store.seed('limit_rules', { id: 'broken', kind: 'nonsense' });
    const res = await api.call('member', 'GET', '/me/quotas');
    expect(res.status).toBe(200);
    const out = items(res.body);
    expect(out.map((q) => `${q.ruleId}:${q.subjectId}`)).toEqual([
      `rule-team:${W.teamA}`,
      `rule-user-quota:${W.memberA}`,
    ]);
    expect(out[1]).toMatchObject({ name: 'Daily calls', consumed: 40, remaining: 60, limit: 100 });
  });
});

describe('17.2 personal access tokens', () => {
  it('9.3 creates a token, shows the secret once and lists metadata only', async () => {
    api = await buildTestApi();
    const created = await api.call('member', 'POST', '/tokens', {
      body: { name: 'laptop', scopes: ['mcp', 'api:read'], expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    const token = String(rec(created.body).token);
    expect(token.length).toBeGreaterThan(20);
    const list = await api.call('member', 'GET', '/tokens');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain('tokenSha256');
    expect(items(list.body)).toHaveLength(1);
    expect(items(list.body)[0]).toMatchObject({
      name: 'laptop',
      scopes: ['mcp', 'api:read'],
      revokedAt: null,
    });
    expect(JSON.stringify(api.uow.audits)).not.toContain(token);
    expect(api.uow.audits.at(-1)).toMatchObject({ action: 'token.create', actorId: W.memberA });
  });

  it('9.3 rejects unknown scopes and offline_access', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/tokens', {
      body: { name: 'x', scopes: ['offline_access'] },
    });
    expect(res.status).toBe(400);
  });

  it('9.3 revokes your own token with If-Match and never someone else’s', async () => {
    api = await buildTestApi();
    const mine = await api.call('member', 'POST', '/tokens', {
      body: { name: 'a', scopes: ['mcp'] },
    });
    const theirs = await api.call('managerOwn', 'POST', '/tokens', {
      body: { name: 'b', scopes: ['mcp'] },
    });
    const mineId = String(rec(rec(mine.body).metadata).id);
    const theirId = String(rec(rec(theirs.body).metadata).id);
    const missing = await api.call('member', 'DELETE', `/tokens/${mineId}`);
    expect(missing.status).toBe(428);
    const version = String(rec(rec(mine.body).metadata).updatedAt);
    const stale = await api.call('member', 'DELETE', `/tokens/${mineId}`, {
      headers: { 'if-match': '"nope"' },
    });
    expect(stale.status).toBe(412);
    const ok = await api.call('member', 'DELETE', `/tokens/${mineId}`, {
      headers: { 'if-match': `"${version}"` },
    });
    expect(ok.status).toBe(204);
    const list = await api.call('member', 'GET', '/tokens');
    expect(items(list.body)[0]?.revokedAt).not.toBeNull();
    const foreign = await api.call('member', 'DELETE', `/tokens/${theirId}`);
    expect(foreign.status).toBe(404);
  });
});

describe('17.2 OAuth grants (9.4)', () => {
  it('9.4 lists and revokes only your own grants', async () => {
    api = await buildTestApi();
    await api.store.seed('oauth_grants', {
      id: 'g-1',
      userId: W.memberA,
      clientId: 'claude',
      scopes: ['mcp'],
    });
    await api.store.seed('oauth_grants', {
      id: 'g-2',
      userId: W.memberB,
      clientId: 'cursor',
      scopes: ['mcp'],
    });
    const list = await api.call('member', 'GET', '/me/oauth-grants');
    expect(items(list.body).map((g) => g.id)).toEqual(['g-1']);
    const foreign = await api.call('member', 'DELETE', '/me/oauth-grants/g-2', {
      headers: { 'if-match': '*' },
    });
    expect(foreign.status).toBe(404);
    const missing = await api.call('member', 'DELETE', '/me/oauth-grants/g-1');
    expect(missing.status).toBe(428);
    const row = await api.store.get('oauth_grants', 'g-1');
    const ok = await api.call('member', 'DELETE', '/me/oauth-grants/g-1', {
      headers: { 'if-match': `"${row?.updatedAt}"` },
    });
    expect(ok.status).toBe(204);
    expect(await api.store.get('oauth_grants', 'g-1')).toBeNull();
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'oauth_grant.revoke',
      diff: { clientId: 'claude' },
    });
  });
});

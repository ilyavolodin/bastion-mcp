import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const ids = (body: unknown): string[] => (rec(body).items as { id: string }[]).map((i) => i.id);
const ifMatch = async (a: TestApi, id: string) => ({
  'if-match': `"${(await a.store.get('marketplaces', id))?.updatedAt}"`,
});

describe('25.4 marketplace audience', () => {
  it('25.4 lists only the marketplaces whose audience includes the caller', async () => {
    api = await buildTestApi();
    expect(ids((await api.call('admin', 'GET', '/marketplaces')).body)).toEqual([
      'mkt-org',
      'mkt-team-a',
      'mkt-team-b',
    ]);
    expect(ids((await api.call('member', 'GET', '/marketplaces')).body)).toEqual([
      'mkt-org',
      'mkt-team-a',
    ]);
    expect(ids((await api.call('managerOther', 'GET', '/marketplaces')).body)).toEqual([
      'mkt-org',
      'mkt-team-b',
    ]);
  });

  it('25.4 hides a marketplace outside the audience and unknown ids from non-admins', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/marketplaces/mkt-team-a')).status).toBe(200);
    expect((await api.call('member', 'GET', '/marketplaces/mkt-team-b')).status).toBe(403);
    expect((await api.call('member', 'GET', '/marketplaces/nope')).status).toBe(403);
    expect((await api.call('admin', 'GET', '/marketplaces/nope')).status).toBe(404);
    const read = await api.call('auditor', 'GET', '/marketplaces/mkt-team-b');
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBeDefined();
  });
});

describe('25.4 marketplace writes', () => {
  const body = { slug: 'new-market', displayName: 'New' };

  it('25.4 a manager creates a marketplace owned by their team, admins create org-owned ones', async () => {
    api = await buildTestApi();
    const own = await api.call('managerOwn', 'POST', '/marketplaces', {
      body: { ...body, ownerTeamId: W.teamA },
    });
    expect(own.status).toBe(201);
    expect(rec(own.body)).toMatchObject({ ownerTeamId: W.teamA, createdBy: W.managerA });
    const other = await api.call('managerOwn', 'POST', '/marketplaces', {
      body: { ...body, slug: 'other', ownerTeamId: W.teamB },
    });
    expect(other.status).toBe(403);
    const orgWide = await api.call('managerOwn', 'POST', '/marketplaces', {
      body: { ...body, slug: 'o2' },
    });
    expect(orgWide.status).toBe(403);
    const admin = await api.call('admin', 'POST', '/marketplaces', {
      body: { ...body, slug: 'o3' },
    });
    expect(admin.status).toBe(201);
    expect(api.uow.audits.at(-1)?.action).toBe('marketplace.create');
  });

  it('25.4 validates the slug, the owner team and uniqueness', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('admin', 'POST', '/marketplaces', { body: { ...body, slug: 'Bad Slug' } }))
        .status,
    ).toBe(400);
    expect(
      (await api.call('admin', 'POST', '/marketplaces', { body: { ...body, ownerTeamId: 'nope' } }))
        .status,
    ).toBe(404);
    expect(
      (await api.call('admin', 'POST', '/marketplaces', { body: { ...body, slug: 'org-market' } }))
        .status,
    ).toBe(409);
  });

  it('25.4 the stored owner decides who may patch or delete, never the request body', async () => {
    api = await buildTestApi();
    const denied = await api.call('managerOwn', 'PATCH', '/marketplaces/mkt-team-b', {
      headers: await ifMatch(api, 'mkt-team-b'),
      body: { displayName: 'Hijack', ownerTeamId: W.teamA },
    });
    expect(denied.status).toBe(403);
    const ok = await api.call('managerOwn', 'PATCH', '/marketplaces/mkt-team-a', {
      headers: await ifMatch(api, 'mkt-team-a'),
      body: { displayName: 'Renamed' },
    });
    expect(ok.status).toBe(200);
    expect(rec(ok.body).displayName).toBe('Renamed');
    const orgOwned = await api.call('managerOwn', 'PATCH', '/marketplaces/mkt-org', {
      headers: await ifMatch(api, 'mkt-org'),
      body: { displayName: 'x' },
    });
    expect(orgOwned.status).toBe(403);
  });

  it('25.4 deleting a marketplace removes its items', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'DELETE', '/marketplaces/mkt-team-a', {
      headers: await ifMatch(api, 'mkt-team-a'),
    });
    expect(res.status).toBe(204);
    expect(await api.store.find('marketplace_items', { marketplaceId: 'mkt-team-a' })).toHaveLength(
      0,
    );
    expect(await api.store.get('marketplaces', 'mkt-team-a')).toBeNull();
  });

  it('25.4 setting an item records it and cuts a release after commit', async () => {
    api = await buildTestApi();
    const before = (await api.call('managerOwn', 'GET', '/marketplaces/mkt-team-a/releases')).body;
    const res = await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/items/entry-mkt-1', {
      headers: {
        'if-match': `"${(await api.store.get('marketplace_items', 'mkt-team-a:entry-mkt-1'))?.updatedAt}"`,
      },
      body: { policy: 'required' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body)).toMatchObject({ policy: 'required', catalogEntryId: 'entry-mkt-1' });
    const after = (await api.call('managerOwn', 'GET', '/marketplaces/mkt-team-a/releases')).body;
    expect((rec(after).items as unknown[]).length).toBe(
      (rec(before).items as unknown[]).length + 1,
    );
    expect(api.uow.audits.at(-1)?.action).toBe('marketplace.item.set');
  });

  it('25.4 adds a new item without If-Match and rejects unknown entries or policies', async () => {
    api = await buildTestApi();
    await api.store.seed('catalog_entries', {
      id: 'entry-2',
      slug: 'two',
      visibility: { org: true, teamIds: [], userIds: [] },
    });
    const add = await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/items/entry-2', {
      body: {},
    });
    expect(add.status).toBe(200);
    expect(rec(add.body)).toMatchObject({ policy: 'available', position: 1 });
    expect(
      (await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/items/missing', { body: {} }))
        .status,
    ).toBe(404);
    expect(
      (await api.call('managerOwn', 'PUT', '/marketplaces/nope/items/entry-2', { body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await api.call('admin', 'PUT', '/marketplaces/nope/items/entry-2', { body: {} })).status,
    ).toBe(404);
    expect(
      (
        await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/items/entry-2', {
          headers: { 'if-match': '*' },
          body: { policy: 'bogus' },
        })
      ).status,
    ).toBe(400);
  });

  it('25.4 removing an item cuts a release; removing a missing one is 404', async () => {
    api = await buildTestApi();
    const row = await api.store.get('marketplace_items', 'mkt-team-a:entry-mkt-1');
    const res = await api.call(
      'managerOwn',
      'DELETE',
      '/marketplaces/mkt-team-a/items/entry-mkt-1',
      {
        headers: { 'if-match': `"${row?.updatedAt}"` },
      },
    );
    expect(res.status).toBe(204);
    const missing = await api.call(
      'managerOwn',
      'DELETE',
      '/marketplaces/mkt-team-a/items/entry-mkt-1',
    );
    expect(missing.status).toBe(404);
  });

  it('25.4 an item change still succeeds when the release build fails', async () => {
    const probe = await buildTestApi();
    const plugins = probe.deps.plugins;
    await probe.close();
    api = await buildTestApi({
      overrides: {
        plugins: {
          ...plugins,
          releaseService: {
            publish: async () => {
              throw new Error('git unavailable');
            },
            promote: plugins.releaseService.promote,
          },
        },
      },
    });
    const res = await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/items/entry-mkt-1', {
      headers: { 'if-match': '*' },
      body: { policy: 'required' },
    });
    expect(res.status).toBe(200);
  });
});

describe('25.4 releases, promotion and mirror', () => {
  it('25.4 lists releases newest first with the promoted one marked', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/marketplaces/mkt-team-a/releases');
    expect((rec(res.body).items as { seq: number }[]).map((r) => r.seq)).toEqual([2, 1]);
    const promoted = await api.call(
      'managerOwn',
      'POST',
      '/marketplaces/mkt-team-a/releases/1/promote',
    );
    expect(promoted.status).toBe(200);
    const again = await api.call('member', 'GET', '/marketplaces/mkt-team-a/releases');
    expect(
      (rec(again.body).items as { seq: number; promoted: boolean }[]).map((r) => r.promoted),
    ).toEqual([false, true]);
    expect(api.uow.audits.at(-1)?.action).toBe('marketplace.release.promote');
    expect(api.publisher.messages.at(-1)?.message).toContain('marketplaces');
  });

  it('25.4 promoting an unknown release is 404; members cannot promote', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('managerOwn', 'POST', '/marketplaces/mkt-team-a/releases/9/promote')).status,
    ).toBe(404);
    expect(
      (await api.call('member', 'POST', '/marketplaces/mkt-team-a/releases/1/promote')).status,
    ).toBe(403);
    expect(
      (await api.call('managerOwn', 'POST', '/marketplaces/mkt-team-a/releases/0/promote')).status,
    ).toBe(400);
  });

  it('25.5 sets the mirror, reads it back and pushes; pushing without a mirror is 409', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('managerOwn', 'POST', '/marketplaces/mkt-team-a/mirror/push')).status,
    ).toBe(409);
    const empty = await api.call('managerOwn', 'GET', '/marketplaces/mkt-team-a/mirror');
    expect(rec(empty.body).mirror).toBeNull();
    const set = await api.call('managerOwn', 'PUT', '/marketplaces/mkt-team-a/mirror', {
      headers: await ifMatch(api, 'mkt-team-a'),
      body: { provider: 'github', repo: 'acme/plugins', credentialSecretId: 'secret-1' },
    });
    expect(set.status).toBe(200);
    expect(rec(rec(set.body).mirror)).toMatchObject({ repo: 'acme/plugins', branch: 'main' });
    const push = await api.call('managerOwn', 'POST', '/marketplaces/mkt-team-a/mirror/push');
    expect(push.status).toBe(200);
    expect(rec(push.body).status).toBe('ok');
    expect(api.uow.audits.at(-1)?.action).toBe('marketplace.mirror.push');
    expect(
      (
        await api.call('member', 'PUT', '/marketplaces/mkt-team-a/mirror', {
          headers: { 'if-match': '*' },
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it('25.7 renders rollout configuration for a client from the latest release', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/marketplaces/mkt-team-a/rollout', {
      query: { client: 'claude-code' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).client).toBe('claude-code');
    expect(JSON.stringify(res.body)).toContain('team-a-market');
    expect(
      (
        await api.call('member', 'GET', '/marketplaces/mkt-team-a/rollout', {
          query: { client: 'nope' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.call('managerOther', 'GET', '/marketplaces/mkt-team-b/rollout', {
          query: { client: 'codex' },
        })
      ).status,
    ).toBe(409);
  });

  it('25.7 Claude Desktop needs a promoted release', async () => {
    api = await buildTestApi();
    const unpromoted = await api.call('member', 'GET', '/marketplaces/mkt-team-a/rollout', {
      query: { client: 'claude-desktop-3p' },
    });
    expect(unpromoted.status).toBe(409);
    await api.call('managerOwn', 'POST', '/marketplaces/mkt-team-a/releases/2/promote');
    const ok = await api.call('member', 'GET', '/marketplaces/mkt-team-a/rollout', {
      query: { client: 'claude-desktop-3p' },
    });
    expect(ok.status).toBe(200);
  });

  it('25.9 returns distribution usage', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/marketplaces/mkt-team-a/usage', {
      query: { from: '2026-05-01T00:00:00.000Z' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).buckets).toHaveLength(1);
    expect((await api.call('member', 'GET', '/marketplaces/mkt-team-b/usage')).status).toBe(403);
  });
});

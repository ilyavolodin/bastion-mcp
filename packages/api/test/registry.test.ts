import type { RegistryServerRow } from '@bastion-mcp/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryServerStore, makeRegistry, maliciousOsv, syncCalls } from './helpers/fakes/registry';
import { buildTestApi, type TestApi } from './helpers/harness';
import { registryServerRows } from './helpers/registry-fixtures';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const items = (v: unknown): Record<string, unknown>[] => rec(v).items as Record<string, unknown>[];

const NPM = { sourceId: 'src-official', name: 'io.github.acme/npm-tool', version: '2.1.0' };
const REMOTE = { sourceId: 'src-official', name: 'io.github.acme/remote-docs', version: '1.0.0' };

const setPolicy = async (t: TestApi, patch: Record<string, unknown>) => {
  const current = await t.call('admin', 'GET', '/registry-sources/src-official/policy');
  const res = await t.call('admin', 'PUT', '/registry-sources/src-official/policy', {
    headers: { 'if-match': String(current.headers.etag ?? '*') },
    body: { ...rec(rec(current.body).policy), ...patch },
  });
  expect(res.status).toBe(200);
};

describe('11.6 registry sources', () => {
  it('11.6 lists, creates and validates sources (https required, private hosts refused)', async () => {
    api = await buildTestApi();
    const list = await api.call('admin', 'GET', '/registry-sources');
    expect(items(list.body)).toHaveLength(1);
    const ok = await api.call('admin', 'POST', '/registry-sources', {
      body: { name: 'Internal', baseUrl: 'https://registry.corp.example/', trust: 'internal' },
    });
    expect(ok.status).toBe(201);
    expect(rec(ok.body).baseUrl).toBe('https://registry.corp.example');
    const bad = await api.call('admin', 'POST', '/registry-sources', {
      body: { name: 'Meta', baseUrl: 'https://169.254.169.254/' },
    });
    expect(bad.status).toBe(400);
    expect(rec(bad.body).code).toBe('registry_url_denied');
    expect(api.uow.audits.map((a) => a.action)).toContain('registry_source.create');
  });

  it('11.6 PATCH needs If-Match and re-validates a changed base URL', async () => {
    api = await buildTestApi();
    const noMatch = await api.call('admin', 'PATCH', '/registry-sources/src-official', {
      body: { name: 'Renamed' },
    });
    expect(noMatch.status).toBe(428);
    const patched = await api.call('admin', 'PATCH', '/registry-sources/src-official', {
      headers: { 'if-match': '*' },
      body: { name: 'Renamed', baseUrl: 'https://other.example.com' },
    });
    expect(patched.status).toBe(200);
    const denied = await api.call('admin', 'PATCH', '/registry-sources/src-official', {
      headers: { 'if-match': '*' },
      body: { baseUrl: 'http://10.0.0.5' },
    });
    expect(denied.status).toBe(400);
  });

  it('11.6 deleting a source removes its policy', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'DELETE', '/registry-sources/src-official', {
      headers: { 'if-match': '*' },
    });
    expect(res.status).toBe(204);
    expect(await api.store.get('registry_policies', 'src-official')).toBeNull();
  });

  it('11.6 sync runs the port, records last_sync and audits', async () => {
    api = await buildTestApi();
    syncCalls.length = 0;
    const res = await api.call('admin', 'POST', '/registry-sources/src-official/sync', {
      body: { full: true },
    });
    expect(res.status).toBe(200);
    // The walk runs after the response is decided, never inside the request transaction.
    expect(rec(res.body).queued).toBe(true);
    await vi.waitFor(() => expect(syncCalls).toEqual([{ id: 'src-official', full: true }]));
    expect(api.uow.audits.at(-1)?.action).toBe('registry_source.sync');
  });

  it('11.7 policy GET returns the stored policy; PUT validates and bumps the ETag', async () => {
    api = await buildTestApi();
    const get = await api.call('admin', 'GET', '/registry-sources/src-official/policy');
    expect(rec(rec(get.body).policy).mode).toBe('direct');
    const bad = await api.call('admin', 'PUT', '/registry-sources/src-official/policy', {
      headers: { 'if-match': String(get.headers.etag) },
      body: { mode: 'banana' },
    });
    expect(bad.status).toBe(400);
    const put = await api.call('admin', 'PUT', '/registry-sources/src-official/policy', {
      headers: { 'if-match': String(get.headers.etag) },
      body: { mode: 'request', allowedRuntimes: ['remote'] },
    });
    expect(put.status).toBe(200);
    expect(put.headers.etag).not.toBe(get.headers.etag);
    expect(rec(rec(put.body).policy).whoMayInstall).toBe('managers');
    const stale = await api.call('admin', 'PUT', '/registry-sources/src-official/policy', {
      headers: { 'if-match': String(get.headers.etag) },
      body: { mode: 'direct' },
    });
    expect(stale.status).toBe(412);
  });

  it('11.7 a source without a stored policy reads the secure defaults (request, remote only)', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', '/registry-sources', {
      body: { name: 'New', baseUrl: 'https://new.example.com' },
    });
    const created = await api.store.find('registry_sources', { name: 'New' });
    const res = await api.call('admin', 'GET', `/registry-sources/${created[0]?.id}/policy`);
    expect(rec(res.body).policy).toMatchObject({ mode: 'request', allowedRuntimes: ['remote'] });
    expect(rec(res.body).updatedAt).toBeNull();
  });
});

describe('11.6 browsing the mirrored registry', () => {
  it('11.6 searches with ?q= and hides deleted entries', async () => {
    api = await buildTestApi();
    const all = await api.call('member', 'GET', '/registry/servers');
    expect(
      items(all.body)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['io.github.acme/npm-tool', 'io.github.acme/remote-docs']);
    const q = await api.call('member', 'GET', '/registry/servers', { query: { q: 'docs' } });
    expect(items(q.body)).toHaveLength(1);
    expect(items(q.body)[0]?.runtimes).toEqual(['remote']);
    const deleted = await api.call('member', 'GET', '/registry/servers', {
      query: { includeDeleted: 'true' },
    });
    expect(items(deleted.body)).toHaveLength(3);
  });

  it('11.7 detail carries the install decision for the caller and the install form', async () => {
    api = await buildTestApi();
    const name = encodeURIComponent('io.github.acme/npm-tool');
    const res = await api.call('member', 'GET', `/registry/servers/src-official/${name}/2.1.0`);
    expect(res.status).toBe(200);
    expect(rec(res.body).install).toMatchObject({
      installable: true,
      decision: 'allowed-direct',
      runtime: 'npm',
    });
    const missing = await api.call('member', 'GET', `/registry/servers/src-official/${name}/9.9.9`);
    expect(missing.status).toBe(404);
  });
});

describe('11.6 what the policy lets people browse', () => {
  const NPM_NAME = 'io.github.acme/npm-tool';
  const REMOTE_NAME = 'io.github.acme/remote-docs';
  const names = (v: unknown) =>
    items(v)
      .map((i) => String(i.name))
      .sort();

  it('11.6 a blocked name disappears from the list of members and managers; Admins and Auditors still see it, marked', async () => {
    api = await buildTestApi();
    await setPolicy(api, { blockedNamespaces: [NPM_NAME] });
    // Members and managers: only what the policy shows.
    for (const actor of ['member', 'managerOwn'] as const) {
      const res = await api.call(actor, 'GET', '/registry/servers');
      expect(names(res.body)).toEqual([REMOTE_NAME]);
      expect(items(res.body)[0]?.visibleToMembers).toBe(true);
    }
    // Admins curate: every server, each saying whether members see it.
    const admin = await api.call('admin', 'GET', '/registry/servers');
    expect(names(admin.body)).toEqual([NPM_NAME, REMOTE_NAME]);
    const flags = Object.fromEntries(items(admin.body).map((i) => [i.name, i.visibleToMembers]));
    expect(flags).toEqual({ [NPM_NAME]: false, [REMOTE_NAME]: true });
  });

  it('11.6 allow only the names you want shown: everything else is hidden from members', async () => {
    api = await buildTestApi();
    await setPolicy(api, { allowedNamespaces: ['io.github.acme/remote-*'] });
    const member = await api.call('member', 'GET', '/registry/servers');
    expect(names(member.body)).toEqual([REMOTE_NAME]);
    // Search cannot reveal a hidden name either.
    const found = await api.call('member', 'GET', '/registry/servers', { query: { q: 'npm' } });
    expect(items(found.body)).toHaveLength(0);
  });

  it('11.6 the detail of a hidden server is a 404 for members (and says nothing about it), a 200 for an Admin', async () => {
    api = await buildTestApi();
    await setPolicy(api, { blockedNamespaces: [NPM_NAME] });
    const path = `/registry/servers/src-official/${encodeURIComponent(NPM_NAME)}/2.1.0`;
    expect((await api.call('member', 'GET', path)).status).toBe(404);
    const admin = await api.call('admin', 'GET', path);
    expect(admin.status).toBe(200);
    expect(rec(admin.body).visibleToMembers).toBe(false);
    // The shown one is unchanged.
    const shown = `/registry/servers/src-official/${encodeURIComponent(REMOTE_NAME)}/1.0.0`;
    expect((await api.call('member', 'GET', shown)).status).toBe(200);
  });

  it('11.6 a member still gets full pages when much of the list is hidden', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      ...(registryServerRows()[0] as RegistryServerRow),
      name: `io.github.${i % 2 === 0 ? 'hidden' : 'shown'}/server-${String(i).padStart(3, '0')}`,
      version: '1.0.0',
      searchDocument: `bulk server ${i}`,
    }));
    api = await buildTestApi({
      overrides: { registry: makeRegistry({ servers: new MemoryServerStore(rows) }) },
    });
    await setPolicy(api, { blockedNamespaces: ['io.github.hidden/*'] });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const res = await api.call('member', 'GET', '/registry/servers', {
        query: { limit: '10', ...(cursor ? { cursor } : {}) },
      });
      seen.push(...items(res.body).map((i) => String(i.name)));
      // Every page that has a successor is full (10 or more shown servers), however many were hidden on the way.
      if (rec(res.body).nextCursor) expect(items(res.body).length).toBeGreaterThanOrEqual(10);
      cursor = rec(res.body).nextCursor ? String(rec(res.body).nextCursor) : undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(30);
    expect(seen.every((n) => n.startsWith('io.github.shown/'))).toBe(true);
  });
});

describe('11.6 paging, filters and provenance of the browse list', () => {
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...(registryServerRows()[0] as RegistryServerRow),
      name: `io.github.bulk/server-${String(i).padStart(3, '0')}`,
      version: '1.0.0',
      searchDocument: `bulk server ${i}`,
    }));

  it('11.6 returns one page per request and continues with the cursor', async () => {
    const servers = new MemoryServerStore(bulk(60));
    api = await buildTestApi({ overrides: { registry: makeRegistry({ servers }) } });
    const first = await api.call('member', 'GET', '/registry/servers', { query: { limit: '24' } });
    expect(items(first.body)).toHaveLength(24);
    const cursor = String(rec(first.body).nextCursor);
    const second = await api.call('member', 'GET', '/registry/servers', {
      query: { limit: '24', cursor },
    });
    expect(items(second.body)).toHaveLength(24);
    const third = await api.call('member', 'GET', '/registry/servers', {
      query: { limit: '24', cursor: String(rec(second.body).nextCursor) },
    });
    expect(items(third.body)).toHaveLength(12);
    expect(rec(third.body).nextCursor).toBeNull();
    const names = [first, second, third].flatMap((r) => items(r.body).map((i) => i.name));
    expect(new Set(names).size).toBe(60);
  });

  it('11.6 asks the store for latest versions of enabled sources only, with the runtime filter', async () => {
    const servers = new MemoryServerStore(bulk(3));
    api = await buildTestApi({ overrides: { registry: makeRegistry({ servers }) } });
    await api.call('member', 'GET', '/registry/servers', { query: { runtime: 'npm' } });
    await api.call('member', 'GET', '/registry/servers', {
      query: { latestOnly: 'false', includeDisabled: 'true' },
    });
    expect(servers.searches[0]).toMatchObject({
      latestOnly: true,
      enabledSourcesOnly: true,
      runtime: 'npm',
    });
    expect(servers.searches[1]).toMatchObject({ latestOnly: false, enabledSourcesOnly: false });
  });

  it('11.6 every result carries its source name, trust level and state', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/registry/servers');
    for (const row of items(res.body)) {
      expect(row).toMatchObject({ sourceId: 'src-official', trust: expect.any(String) });
      expect(typeof row.sourceName).toBe('string');
      expect(typeof row.sourceEnabled).toBe('boolean');
    }
  });

  it('11.6 enabling a source starts its initial sync; a disabled source cannot be synced', async () => {
    api = await buildTestApi();
    syncCalls.length = 0;
    const created = await api.call('admin', 'POST', '/registry-sources', {
      body: { name: 'Off', baseUrl: 'https://off.example.com', enabled: false },
    });
    expect(created.status).toBe(201);
    expect(syncCalls).toHaveLength(0);
    const id = String(rec(created.body).id);
    const refused = await api.call('admin', 'POST', `/registry-sources/${id}/sync`, { body: {} });
    expect(refused.status).toBe(409);
    expect(rec(refused.body).code).toBe('source_disabled');
    const enabled = await api.call('admin', 'PATCH', `/registry-sources/${id}`, {
      headers: { 'if-match': '*' },
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    await vi.waitFor(() => expect(syncCalls).toEqual([{ id, full: true }]));
  });
});

describe('11.7 one-click install', () => {
  it('11.7 direct mode creates the entry, a pinned version and the installation in one transaction', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(res.status).toBe(201);
    expect(rec(res.body).decision).toBe('installed');
    const installations = await api.store.find('installations', {
      ownerId: 'user-member-a',
      origin: 'registry',
    });
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      origin: 'registry',
      ownerType: 'user',
      pinnedVersion: true,
    });
    const entries = await api.store.find('catalog_entries', {
      registryServerName: 'io.github.acme/remote-docs',
    });
    expect(entries[0]?.visibility).toMatchObject({ org: false, userIds: ['user-member-a'] });
    expect(await api.store.find('catalog_versions', { entryId: entries[0]?.id })).toHaveLength(1);
    expect(api.uow.audits.map((a) => a.action)).toContain('registry.install');
  });

  it('11.7 reuses the catalog entry for a second user and keeps one version', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    await api.call('admin', 'POST', '/registry/install', { body: REMOTE });
    expect(
      await api.store.find('catalog_entries', { registryServerName: REMOTE.name }),
    ).toHaveLength(1);
    const entry = (await api.store.find('catalog_entries', { registryServerName: REMOTE.name }))[0];
    expect(await api.store.find('installations', { catalogEntryId: entry?.id })).toHaveLength(2);
  });

  it('11.7 an npm install marks the installation needs_setup when it has secrets', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/registry/install', { body: NPM });
    expect(res.status).toBe(201);
    const inst = await api.store.find('installations', {
      ownerId: 'user-member-a',
      origin: 'registry',
    });
    expect(inst[0]?.status).toBe('needs_setup');
  });

  it('11.7 request mode answers 202 and creates nothing', async () => {
    api = await buildTestApi();
    await setPolicy(api, { mode: 'request' });
    const res = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(res.status).toBe(202);
    expect(rec(res.body).decision).toBe('needs-request');
    expect(await api.store.find('installations', { origin: 'registry' })).toHaveLength(0);
  });

  it('11.7 direct above maxRisk degrades to a request; catalogOnly is a 409 with canImport', async () => {
    api = await buildTestApi();
    await setPolicy(api, { maxRisk: 'low' });
    await api.store.update('registry_sources', 'src-official', { trust: 'community' });
    const degraded = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(degraded.status).toBe(202);
    await setPolicy(api, { mode: 'catalogOnly' });
    const only = await api.call('managerOwn', 'POST', '/registry/install', { body: REMOTE });
    expect(only.status).toBe(409);
    expect(rec(only.body).code).toBe('catalog_only');
  });

  it('11.7 denies runtimes and namespaces the policy does not allow with a 403', async () => {
    api = await buildTestApi();
    await setPolicy(api, { allowedRuntimes: ['remote'] });
    const runtime = await api.call('member', 'POST', '/registry/install', { body: NPM });
    expect(runtime.status).toBe(403);
    await setPolicy(api, { blockedNamespaces: ['io.github.acme/*'] });
    const ns = await api.call('member', 'POST', '/registry/install', { body: REMOTE });
    expect(ns.status).toBe(403);
  });

  it('11.7 whoMayInstall=managers keeps members out', async () => {
    api = await buildTestApi();
    await setPolicy(api, { whoMayInstall: 'managers' });
    expect((await api.call('member', 'POST', '/registry/install', { body: REMOTE })).status).toBe(
      403,
    );
    expect(
      (await api.call('managerOwn', 'POST', '/registry/install', { body: REMOTE })).status,
    ).toBe(201);
  });

  it('11.7 the OSV gate blocks known-malicious packages and fails closed', async () => {
    api = await buildTestApi({ overrides: { registry: makeRegistry({ fetch: maliciousOsv }) } });
    const res = await api.call('member', 'POST', '/registry/install', { body: NPM });
    expect(res.status).toBe(422);
    expect(rec(res.body).code).toBe('osv_blocked');
    expect(await api.store.find('installations', { origin: 'registry' })).toHaveLength(0);
    const failing = await buildTestApi({
      overrides: {
        registry: makeRegistry({ fetch: async () => new Response('nope', { status: 500 }) }),
      },
    });
    const closed = await failing.call('member', 'POST', '/registry/install', { body: NPM });
    await failing.close();
    expect(closed.status).toBe(422);
  });

  it('11.6 refuses deleted, unknown and disabled sources or servers', async () => {
    api = await buildTestApi();
    const gone = await api.call('member', 'POST', '/registry/install', {
      body: { sourceId: 'src-official', name: 'io.github.acme/gone', version: '0.1.0' },
    });
    expect(gone.status).toBe(409);
    expect(
      (await api.call('member', 'POST', '/registry/install', { body: { ...REMOTE, version: '0' } }))
        .status,
    ).toBe(404);
    await api.store.update('registry_sources', 'src-official', { enabled: false });
    expect((await api.call('member', 'POST', '/registry/install', { body: REMOTE })).status).toBe(
      409,
    );
  });

  it('10.1 auditors cannot install', async () => {
    api = await buildTestApi();
    expect((await api.call('auditor', 'POST', '/registry/install', { body: REMOTE })).status).toBe(
      403,
    );
  });
});

describe('11.7 install requests', () => {
  it('11.7 a member files a request; admins and the team manager are notified', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/install-requests', {
      body: { ...REMOTE, justification: 'Need the docs' },
    });
    expect(res.status).toBe(201);
    expect(rec(res.body).status).toBe('open');
    const notes = await api.store.find('notifications', {});
    expect(notes.map((n) => n.userId).sort()).toEqual(['user-admin', 'user-manager-a']);
    expect(api.events.published.filter((e) => e.type === 'notification')).toHaveLength(2);
  });

  it('11.7 requires a justification and refuses duplicates of an open request', async () => {
    api = await buildTestApi();
    expect(
      (
        await api.call('member', 'POST', '/install-requests', {
          body: { ...REMOTE, justification: '  ' },
        })
      ).status,
    ).toBe(400);
    const dup = await api.call('member', 'POST', '/install-requests', {
      body: { ...NPM, justification: 'again' },
    });
    expect(dup.status).toBe(409);
    expect(rec(dup.body).code).toBe('request_exists');
  });

  it('11.7 lists own requests for members, team requests for managers, all for admins', async () => {
    api = await buildTestApi();
    await api.store.seed('install_requests', {
      id: 'req-b',
      requesterId: 'user-member-b',
      sourceId: 'src-official',
      serverName: REMOTE.name,
      version: REMOTE.version,
      justification: 'b',
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      reason: null,
      createdAt: '2026-06-01T11:00:00.000Z',
    });
    const ids = async (actor: 'member' | 'managerOwn' | 'managerOther' | 'admin') =>
      items((await api?.call(actor, 'GET', '/install-requests'))?.body).map((i) => i.id);
    expect(await ids('member')).toEqual(['req-1']);
    expect(await ids('managerOwn')).toEqual(['req-1']);
    expect(await ids('managerOther')).toEqual(['req-b']);
    expect((await ids('admin')).sort()).toEqual(['req-1', 'req-b']);
    const open = await api.call('admin', 'GET', '/install-requests', {
      query: { status: 'approved' },
    });
    expect(items(open.body)).toHaveLength(0);
  });

  it('11.7 a manager of the requester approves: the plan runs for the requester in the same transaction', async () => {
    api = await buildTestApi();
    const res = await api.call('managerOwn', 'POST', '/install-requests/req-1/approve');
    expect(res.status).toBe(200);
    expect(rec(res.body)).toMatchObject({ status: 'approved', decidedBy: 'user-manager-a' });
    const inst = await api.store.find('installations', {
      ownerId: 'user-member-a',
      origin: 'registry',
    });
    expect(inst).toHaveLength(1);
    const actions = api.uow.audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['registry.install_request.approve', 'registry.install']),
    );
    const notes = await api.store.find('notifications', { userId: 'user-member-a' });
    expect(notes).toHaveLength(1);
    const again = await api.call('managerOwn', 'POST', '/install-requests/req-1/approve');
    expect(again.status).toBe(409);
  });

  it('10.1 managers of another team, members and unknown ids cannot decide', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOther', 'POST', '/install-requests/req-1/approve')).status).toBe(
      403,
    );
    expect((await api.call('member', 'POST', '/install-requests/req-1/approve')).status).toBe(403);
    expect((await api.call('managerOwn', 'POST', '/install-requests/nope/approve')).status).toBe(
      403,
    );
    expect((await api.call('admin', 'POST', '/install-requests/nope/approve')).status).toBe(404);
  });

  it('11.7 reject needs a reason and notifies the requester', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('admin', 'POST', '/install-requests/req-1/reject', { body: { reason: ' ' } }))
        .status,
    ).toBe(400);
    const res = await api.call('admin', 'POST', '/install-requests/req-1/reject', {
      body: { reason: 'Not approved' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body)).toMatchObject({ status: 'rejected', reason: 'Not approved' });
    expect(await api.store.find('installations', { origin: 'registry' })).toHaveLength(0);
    const notes = await api.store.find('notifications', { userId: 'user-member-a' });
    expect(rec(notes[0]?.data).reason).toBe('Not approved');
  });

  it('11.7 approval is blocked by the OSV gate and leaves the request open', async () => {
    api = await buildTestApi({ overrides: { registry: makeRegistry({ fetch: maliciousOsv }) } });
    const res = await api.call('admin', 'POST', '/install-requests/req-1/approve');
    expect(res.status).toBe(422);
    expect((await api.store.get('install_requests', 'req-1'))?.status).toBe('open');
  });
});

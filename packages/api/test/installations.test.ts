import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeInstallations } from './helpers/fakes/installations';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const items = (v: unknown): Record<string, unknown>[] => rec(v).items as Record<string, unknown>[];
const ids = (v: unknown): string[] => items(v).map((i) => String(i.id));

const etagOf = async (
  a: TestApi,
  url: string,
  actor: 'admin' | 'member' | 'managerOwn' = 'admin',
) => String((await a.call(actor, 'GET', url)).headers.etag);

describe('11.4 installations: listing and reading', () => {
  it('11.4 lists only the installations the caller may manage (members: their own)', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/installations');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['inst-member-a']);
  });

  it('11.4 a manager sees their team installations, an admin sees everything', async () => {
    api = await buildTestApi();
    const mgr = await api.call('managerOwn', 'GET', '/installations');
    expect(ids(mgr.body)).toContain('inst-team-a');
    expect(ids(mgr.body)).not.toContain('inst-team-b');
    const admin = await api.call('admin', 'GET', '/installations');
    expect(ids(admin.body)).toEqual(
      expect.arrayContaining(['inst-member-a', 'inst-team-a', 'inst-team-b', 'inst-svc-a']),
    );
  });

  it('17.1 filters by catalogEntryId and supports ?q=', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/installations', {
      query: { catalogEntryId: 'entry-team-a' },
    });
    expect(ids(res.body)).toEqual(['inst-team-a']);
    const q = await api.call('admin', 'GET', '/installations', { query: { q: 'inst-team-b' } });
    expect(ids(q.body)).toEqual(['inst-team-b']);
  });

  it('10 a member cannot read another users installation, 404-safe for missing ones', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/installations/inst-member-b')).status).toBe(403);
    expect((await api.call('member', 'GET', '/installations/inst-member-a')).status).toBe(200);
    expect((await api.call('member', 'GET', '/installations/nope')).status).toBe(403);
    expect((await api.call('admin', 'GET', '/installations/nope')).status).toBe(404);
  });
});

describe('11.4 installations: creating', () => {
  it('11.4 installs a published catalog entry for the caller', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/installations', {
      body: { catalogEntryId: 'entry-i-pub', variables: { REGION: 'eu' } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ownerType: 'user',
      ownerId: 'user-member-a',
      catalogEntryId: 'entry-i-pub',
      catalogVersionId: 'ver-entry-i-pub',
      slug: 'entry-i-pub',
      toolPrefix: 'entry_i_pub',
      origin: 'catalog',
      status: 'ready',
    });
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'installation.create',
      actorId: 'user-member-a',
    });
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"installations"}');
    expect(api.events.published.at(-1)?.type).toBe('installation.status');
  });

  it('10 a member cannot install an entry that is not visible to them', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/installations', {
      body: { catalogEntryId: 'entry-team-b' },
    });
    expect(res.status).toBe(403);
  });

  it('11.4 rejects unpublished entries and unpublished versions', async () => {
    api = await buildTestApi();
    const noVersion = await api.call('admin', 'POST', '/installations', {
      body: { catalogEntryId: 'entry-i-draft' },
    });
    expect(noVersion.status).toBe(409);
    expect(rec(noVersion.body).code).toBe('no_published_version');
    const draft = await api.call('admin', 'POST', '/installations', {
      body: { catalogEntryId: 'entry-i-draft', catalogVersionId: 'ver-draft-i' },
    });
    expect(draft.status).toBe(409);
    expect(rec(draft.body).code).toBe('version_not_published');
  });

  it('7.1 refuses a slug that collides with an effective slug the user can see', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/installations', {
      body: { catalogEntryId: 'entry-org', slug: 'inst-member-a' },
    });
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('slug_collision');
  });

  it('10.1 managers create team installations for their own team only', async () => {
    api = await buildTestApi();
    const ok = await api.call('managerOwn', 'POST', '/installations', {
      body: {
        catalogEntryId: 'entry-team-a',
        ownerType: 'team',
        teamId: 'team-a',
        slug: 'shared-a',
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ ownerType: 'team', ownerId: 'team-a' });
    const other = await api.call('managerOther', 'POST', '/installations', {
      body: {
        catalogEntryId: 'entry-team-a',
        ownerType: 'team',
        teamId: 'team-a',
        slug: 'shared-b',
      },
    });
    expect(other.status).toBe(403);
    const dup = await api.call('managerOwn', 'POST', '/installations', {
      body: {
        catalogEntryId: 'entry-team-a',
        ownerType: 'team',
        teamId: 'team-a',
        slug: 'shared-a',
      },
    });
    expect(dup.status).toBe(409);
  });

  it('17.2 validates the body: exactly one source, team needs teamId', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'POST', '/installations', { body: {} })).status).toBe(400);
    expect(
      (
        await api.call('admin', 'POST', '/installations', {
          body: { catalogEntryId: 'entry-org', ownerType: 'team' },
        })
      ).status,
    ).toBe(400);
  });

  const spec = (type: 'remote' | 'package') =>
    type === 'remote'
      ? {
          type: 'remote',
          transport: 'streamable-http',
          url: 'https://tools.example.com/mcp',
          auth: { mode: 'none' },
        }
      : {
          type: 'package',
          runtime: 'npm',
          identifier: '@x/y',
          version: '1.0.0',
          auth: { mode: 'none' },
        };

  it('19.2 personal installs honor personalInstalls: remoteOnly by default', async () => {
    api = await buildTestApi();
    const remote = await api.call('member', 'POST', '/installations', {
      body: { personalSpec: spec('remote'), slug: 'my-remote' },
    });
    expect(remote.status).toBe(201);
    expect(remote.body).toMatchObject({
      origin: 'personal',
      ownerId: 'user-member-a',
      catalogEntryId: null,
    });
    const pkg = await api.call('member', 'POST', '/installations', {
      body: { personalSpec: spec('package'), slug: 'my-pkg' },
    });
    expect(pkg.status).toBe(403);
  });

  it('19.2 personalInstalls=off blocks personal installs; all allows packages', async () => {
    api = await buildTestApi();
    await api.store.seed('settings', { id: 'personalInstalls', value: 'off' });
    const off = await api.call('member', 'POST', '/installations', {
      body: { personalSpec: spec('remote'), slug: 'p1' },
    });
    expect(off.status).toBe(403);
    expect(rec(off.body).code).toBe('forbidden');
    await api.store.upsert('settings', 'personalInstalls', { value: 'all' });
    const all = await api.call('member', 'POST', '/installations', {
      body: { personalSpec: spec('package'), slug: 'p2' },
    });
    expect(all.status).toBe(201);
  });
});

describe('11.4 installations: updating and deleting', () => {
  it('11.4 PATCH changes display name and enabled flag under If-Match', async () => {
    api = await buildTestApi();
    const etag = await etagOf(api, '/installations/inst-member-a', 'member');
    const res = await api.call('member', 'PATCH', '/installations/inst-member-a', {
      headers: { 'if-match': etag },
      body: { displayName: 'Mine', enabled: false },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Mine', enabled: false });
    expect(api.uow.audits.at(-1)?.action).toBe('installation.update');
  });

  it('11.4 upgrading to another version needs a published version of the same entry', async () => {
    api = await buildTestApi();
    const etag = await etagOf(api, '/installations/inst-team-a');
    const draft = await api.call('admin', 'PATCH', '/installations/inst-team-a', {
      headers: { 'if-match': etag },
      body: { catalogVersionId: 'ver-team-a-draft' },
    });
    expect(draft.status).toBe(409);
    const foreign = await api.call('admin', 'PATCH', '/installations/inst-team-a', {
      headers: { 'if-match': etag },
      body: { catalogVersionId: 'ver-entry-org' },
    });
    expect(foreign.status).toBe(404);
  });

  it('17.1 DELETE requires If-Match and removes the installation', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'DELETE', '/installations/inst-member-a')).status).toBe(428);
    const etag = await etagOf(api, '/installations/inst-member-a', 'member');
    const res = await api.call('member', 'DELETE', '/installations/inst-member-a', {
      headers: { 'if-match': etag },
    });
    expect(res.status).toBe(204);
    expect(await api.store.get('installations', 'inst-member-a')).toBeNull();
    expect(api.uow.audits.at(-1)?.action).toBe('installation.delete');
  });
});

describe('11.4 installations: runtime operations', () => {
  it('11.4 restart calls the runtime and audits', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    const res = await api.call('member', 'POST', '/installations/inst-member-a/restart');
    expect(res.status).toBe(200);
    expect(fake.calls.restart).toEqual(['inst-member-a']);
    expect(api.uow.audits.at(-1)?.action).toBe('installation.restart');
  });

  it('11.4 egress returns recent decisions', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/installations/inst-member-a/egress', {
      query: { limit: '5' },
    });
    expect(res.status).toBe(200);
    expect(items(res.body)[0]).toMatchObject({ host: 'api.example.com', decision: 'allowed' });
  });

  it('11.5 connect returns the upstream authorization URL', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    const res = await api.call('member', 'POST', '/installations/inst-member-a/connect', {
      body: { returnTo: '/installations' },
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).authorizationUrl).toContain('https://auth.example.com/authorize');
    expect(fake.calls.connect[0]).toEqual({
      installationId: 'inst-member-a',
      principalId: 'user-member-a',
      returnTo: '/installations',
    });
  });

  it('11.5 disconnect revokes the upstream token and marks the installation reconnect_required', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    const etag = await etagOf(api, '/installations/inst-member-a', 'member');
    const res = await api.call('member', 'DELETE', '/installations/inst-member-a/connection', {
      headers: { 'if-match': etag },
    });
    expect(res.status).toBe(204);
    expect(fake.calls.disconnect).toHaveLength(1);
    expect((await api.store.get('installations', 'inst-member-a'))?.status).toBe(
      'reconnect_required',
    );
  });

  it('22.3 PUT secret stores the value in the vault and never returns it', async () => {
    api = await buildTestApi();
    const etag = await etagOf(api, '/installations/inst-member-a', 'member');
    const res = await api.call('member', 'PUT', '/installations/inst-member-a/secrets/API_KEY', {
      headers: { 'if-match': etag },
      body: { value: 'super-secret-value' },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain('super-secret-value');
    expect(res.body).toMatchObject({ name: 'API_KEY', scope: 'user', version: 1 });
    const stored = [...api.secrets.rows.values()][0];
    expect(stored).toMatchObject({
      scope: 'user',
      ownerId: 'user-member-a',
      name: 'inst-member-a.API_KEY',
      value: 'super-secret-value',
    });
    const row = await api.store.get('installations', 'inst-member-a');
    expect(JSON.stringify(row)).not.toContain('super-secret-value');
    expect(rec(rec(row?.secretRefs).API_KEY).version).toBe(1);
    expect(JSON.stringify(api.uow.audits)).not.toContain('super-secret-value');
  });

  it('11.4 team installation secrets are team scoped, service ones use the accounts team', async () => {
    api = await buildTestApi();
    const t = await etagOf(api, '/installations/inst-team-a');
    const team = await api.call('managerOwn', 'PUT', '/installations/inst-team-a/secrets/TOKEN', {
      headers: { 'if-match': t },
      body: { value: 'x' },
    });
    expect(team.body).toMatchObject({ scope: 'team' });
    const s = await etagOf(api, '/installations/inst-svc-a');
    const svc = await api.call('admin', 'PUT', '/installations/inst-svc-a/secrets/TOKEN', {
      headers: { 'if-match': s },
      body: { value: 'y' },
    });
    expect(svc.body).toMatchObject({ scope: 'team' });
    expect([...api.secrets.rows.values()].map((r) => r.ownerId)).toEqual(['team-a', 'team-a']);
  });

  it('11.4 try runs a call through the pipeline as the caller (no audit transaction)', async () => {
    const fake = makeFakeInstallations();
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    const res = await api.call('member', 'POST', '/installations/inst-member-a/try', {
      body: { kind: 'tool', name: 'search', arguments: { q: 'x' } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isError: false, callId: 'call-1' });
    expect(fake.calls.tried[0]).toMatchObject({
      principalId: 'user-member-a',
      request: { kind: 'tool', name: 'search' },
    });
    expect(api.uow.audits).toHaveLength(0);
    expect(
      (
        await api.call('member', 'POST', '/installations/inst-member-a/try', {
          body: { kind: 'x' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('12.5 installations: final definitions', () => {
  it('12.5 tools are compiled by the router with the layers applied', async () => {
    api = await buildTestApi();
    await api.store.update('installations', 'inst-member-a', {
      overrides: { version: 1, tools: { search: { description: 'Mine' } } },
    });
    const res = await api.call('member', 'GET', '/installations/inst-member-a/tools');
    expect(res.status).toBe(200);
    const tools = items(res.body);
    expect(tools.map((t) => t.name)).toEqual(['delete', 'search']);
    expect(tools.find((t) => t.name === 'search')?.description).toBe('Mine');
    const meta = rec(res.body).meta as Array<Record<string, unknown>>;
    expect(meta.find((m) => m.upstreamKey === 'search')).toMatchObject({ overridden: true });
  });

  it('12.5 hidden tools disappear from the final list', async () => {
    api = await buildTestApi();
    await api.store.update('installations', 'inst-member-a', {
      overrides: { version: 1, tools: { delete: { hidden: true } } },
    });
    const res = await api.call('member', 'GET', '/installations/inst-member-a/tools');
    expect(items(res.body).map((t) => t.name)).toEqual(['search']);
  });

  it('12.5 catalog layer overrides apply beneath the installation layer', async () => {
    api = await buildTestApi();
    await api.store.update('catalog_versions', 'ver-entry-org', {
      overrides: { version: 1, tools: { search: { description: 'From catalog' } } },
    });
    const res = await api.call('member', 'GET', '/installations/inst-member-a/tools');
    expect(items(res.body).find((t) => t.name === 'search')?.description).toBe('From catalog');
  });

  it('12.5 serves prompts, resources and templates and the instructions', async () => {
    api = await buildTestApi();
    const prompts = await api.call('member', 'GET', '/installations/inst-member-a/prompts');
    expect(items(prompts.body).map((p) => p.name)).toEqual(['summarize']);
    const resources = await api.call('member', 'GET', '/installations/inst-member-a/resources');
    expect(items(resources.body)).toHaveLength(1);
    const templates = await api.call('member', 'GET', '/installations/inst-member-a/templates');
    expect(items(templates.body)).toHaveLength(1);
    expect(rec(prompts.body).instructions).toContain('search tool first');
  });

  it('7.5 reports a degraded upstream instead of failing', async () => {
    const fake = makeFakeInstallations();
    fake.setDegraded('list_failed');
    api = await buildTestApi({ overrides: { installations: fake.deps } });
    const res = await api.call('member', 'GET', '/installations/inst-member-a/tools');
    expect(res.status).toBe(200);
    expect(items(res.body)).toEqual([]);
    expect(rec(res.body).degraded).toEqual([
      { installation: 'inst-member-a', code: 'list_failed' },
    ]);
  });

  it('12.5 an admin inspecting a user installation sees what the owner sees', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/installations/inst-member-a/tools');
    expect(res.status).toBe(200);
    expect(items(res.body)).toHaveLength(2);
  });
});

describe('11.4 installations: logs (SSE)', () => {
  it('11.4 follow=false sends the tail and ends the stream', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/installations/inst-member-a/logs', {
      query: { follow: 'false', tail: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.raw).toContain('event: log');
    expect(res.raw).toContain('listening on stdio');
    expect(res.raw).not.toContain('starting');
  });

  it('11.4 streams the stderr tail then live log events', async () => {
    api = await buildTestApi({ overrides: {} });
    const { app } = api;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/installations/inst-member-a/logs?tail=1`,
      {
        headers: { authorization: 'Bearer tok-member' },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (until: string) => {
      while (!text.includes(until)) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    };
    await read('listening on stdio');
    expect(text).toContain('event: log');
    expect(text).toContain('listening on stdio');
    api.events.publish({
      id: 'e1',
      type: 'installation.log',
      audience: { userIds: ['user-member-a'] },
      topic: 'inst-member-a',
      data: { line: 'live line' },
    });
    await read('live line');
    expect(text).toContain('live line');
    controller.abort();
  });

  it('10 denies the log stream to other users', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/installations/inst-member-b/logs');
    expect(res.status).toBe(403);
  });
});

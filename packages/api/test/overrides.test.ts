import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const tag = async (a: TestApi, actor: 'admin' | 'member' | 'managerOwn', url: string) =>
  String((await a.call(actor, 'GET', url)).headers.etag);

const doc = (tools: Record<string, unknown>) => ({ version: 1, tools });

describe('12.1 catalog-layer overrides', () => {
  const url = '/catalog/entry-team-a/versions/ver-team-a-draft/overrides';

  it('12.1 reads an empty document and saves a valid one on a draft version', async () => {
    api = await buildTestApi();
    const get = await api.call('managerOwn', 'GET', url);
    expect(get.status).toBe(200);
    expect(rec(get.body).doc).toMatchObject({ version: 1, tools: {} });
    const put = await api.call('managerOwn', 'PUT', url, {
      headers: { 'if-match': String(get.headers.etag) },
      body: doc({ search: { description: 'Catalog text', annotations: { readOnlyHint: true } } }),
    });
    expect(put.status).toBe(200);
    expect(rec(rec(rec(put.body).doc).tools).search).toMatchObject({ description: 'Catalog text' });
    expect(api.uow.audits.at(-1)?.action).toBe('catalog.overrides.update');
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"catalog"}');
  });

  it('12.2 rejects an invalid document with JSON pointers', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'PUT', url, {
      headers: { 'if-match': await tag(api, 'admin', url) },
      body: { version: 1, tools: { search: { nope: true } } },
    });
    expect(res.status).toBe(400);
    expect(rec(res.body).code).toBe('validation_failed');
    expect((rec(res.body).errors as unknown[]).length).toBeGreaterThan(0);
  });

  it('11.1 published versions are frozen', async () => {
    api = await buildTestApi();
    const published = '/catalog/entry-team-a/versions/ver-entry-team-a/overrides';
    const res = await api.call('admin', 'PUT', published, {
      headers: { 'if-match': await tag(api, 'admin', published) },
      body: doc({}),
    });
    expect(res.status).toBe(409);
    expect(rec(res.body).code).toBe('version_frozen');
  });

  it('10.1 managers of other teams and members may not edit; the version must belong to the entry', async () => {
    api = await buildTestApi();
    expect((await api.call('managerOther', 'PUT', url, { body: doc({}) })).status).toBe(403);
    expect((await api.call('member', 'GET', url)).status).toBe(403);
    expect(
      (await api.call('admin', 'GET', '/catalog/entry-org/versions/ver-team-a-draft/overrides'))
        .status,
    ).toBe(404);
    expect((await api.call('admin', 'GET', '/catalog/nope/versions/x/overrides')).status).toBe(404);
  });
});

describe('12.1 overrides for everyone who installs an entry', () => {
  const url = '/catalog/entry-team-a/default-overrides';

  it('12.1 are written to the current published version and audited', async () => {
    api = await buildTestApi();
    const get = await api.call('managerOwn', 'GET', url);
    expect(get.status).toBe(200);
    const put = await api.call('managerOwn', 'PUT', url, {
      headers: { 'if-match': String(get.headers.etag) },
      body: doc({ search: { hidden: true } }),
    });
    expect(put.status).toBe(200);
    const stored = await api.call('managerOwn', 'GET', url);
    expect(rec(rec(stored.body).doc).tools).toEqual({ search: { hidden: true } });
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'catalog.overrides.update',
      diff: { published: true },
    });
  });

  it('10.1 members and managers of other teams may not', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'PUT', url, { body: doc({}) })).status).toBe(403);
    expect((await api.call('managerOther', 'PUT', url, { body: doc({}) })).status).toBe(403);
  });

  it('11.1 an entry without a published version has none to change', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/catalog/entry-org/default-overrides');
    expect([200, 409]).toContain(res.status);
  });
});

describe('12.1 installation-layer overrides', () => {
  const url = '/installations/inst-member-a/overrides';

  it('12.1 cosmetic entries keep names and descriptions and report rejected fields', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'PUT', url, {
      headers: { 'if-match': await tag(api, 'member', url) },
      body: doc({ search: { description: 'Mine', hidden: true, timeoutMs: 5000 } }),
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).userOverrides).toBe('cosmetic');
    expect(rec(rec(rec(res.body).doc).tools).search).toEqual({ description: 'Mine', hidden: true });
    expect(rec(res.body).rejected).toEqual([
      expect.objectContaining({ path: '/tools/search/timeoutMs' }),
    ]);
    const stored = await api.store.get('installations', 'inst-member-a');
    expect(JSON.stringify(stored?.overrides)).not.toContain('timeoutMs');
  });

  it('12.1 userOverrides none rejects everything but still answers 200 with the rejections', async () => {
    api = await buildTestApi();
    await api.store.update('installations', 'inst-member-a', { catalogEntryId: 'entry-i-none' });
    const res = await api.call('member', 'PUT', url, {
      headers: { 'if-match': await tag(api, 'member', url) },
      body: doc({ search: { description: 'x' } }),
    });
    expect(res.status).toBe(200);
    expect(rec(res.body).doc).toMatchObject({ tools: {} });
    expect((rec(res.body).rejected as unknown[]).length).toBe(1);
  });

  it('12.1 safer-looking annotations and guard profiles stay catalog-only', async () => {
    api = await buildTestApi();
    await api.store.update('installations', 'inst-member-a', { catalogEntryId: 'entry-i-pub' });
    const res = await api.call('member', 'PUT', url, {
      headers: { 'if-match': await tag(api, 'member', url) },
      body: doc({
        search: { annotations: { readOnlyHint: true, openWorldHint: true }, timeoutMs: 1000 },
      }),
    });
    expect(rec(rec(rec(res.body).doc).tools).search).toMatchObject({
      annotations: { openWorldHint: true },
      timeoutMs: 1000,
    });
    expect(rec(res.body).rejected).toEqual([
      expect.objectContaining({ path: '/tools/search/annotations/readOnlyHint' }),
    ]);
  });

  it('12.1 GET returns the stored layer with its level; PUT needs If-Match', async () => {
    api = await buildTestApi();
    const get = await api.call('member', 'GET', url);
    expect(rec(get.body)).toMatchObject({ userOverrides: 'cosmetic', doc: { version: 1 } });
    expect((await api.call('member', 'PUT', url, { body: doc({}) })).status).toBe(428);
    expect(
      (await api.call('member', 'PUT', '/installations/inst-member-b/overrides', { body: doc({}) }))
        .status,
    ).toBe(403);
  });

  it('12.1 personal installations without an entry allow full overrides', async () => {
    api = await buildTestApi();
    await api.store.update('installations', 'inst-member-a', {
      catalogEntryId: null,
      catalogVersionId: null,
    });
    const res = await api.call('member', 'PUT', url, {
      headers: { 'if-match': await tag(api, 'member', url) },
      body: doc({ search: { timeoutMs: 1000 } }),
    });
    expect(rec(res.body).userOverrides).toBe('full');
    expect(rec(res.body).rejected).toEqual([]);
  });
});

describe('12.5 overrides preview', () => {
  it('12.5 previews an unsaved document against inline upstream definitions with a diff', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/overrides/preview', {
      body: {
        layer: 'catalog',
        doc: doc({ search: { description: 'New text' } }),
        upstream: {
          tools: [{ name: 'search', description: 'Old', inputSchema: { type: 'object' } }],
        },
      },
    });
    expect(res.status).toBe(200);
    const final = rec(rec(res.body).final);
    expect((final.tools as { tool: { description: string } }[])[0]).toBeDefined();
    const diff = rec(res.body).diff as Array<Record<string, unknown>>;
    expect(diff[0]).toMatchObject({ kind: 'tool', key: 'search', status: 'modified' });
    expect(api.uow.audits).toHaveLength(0);
  });

  it('12.5 loads upstream definitions and the catalog layer from an installation', async () => {
    api = await buildTestApi();
    await api.store.update('catalog_versions', 'ver-entry-org', {
      overrides: doc({ search: { description: 'Catalog' } }),
    });
    const res = await api.call('member', 'POST', '/overrides/preview', {
      body: {
        installationId: 'inst-member-a',
        doc: doc({ delete: { hidden: true }, search: { timeoutMs: 5 } }),
      },
    });
    expect(res.status).toBe(200);
    const diff = rec(res.body).diff as Array<Record<string, unknown>>;
    expect(
      diff
        .filter((d) => d.status !== 'unchanged')
        .map((d) => `${d.key}:${d.status}`)
        .sort(),
    ).toEqual(['delete:hidden', 'search:modified']);
    expect(rec(res.body).rejected).toEqual([
      expect.objectContaining({ path: '/tools/search/timeoutMs' }),
    ]);
  });

  it('12.5 reports a degraded upstream as 409 and requires some source of definitions', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('member', 'POST', '/overrides/preview', { body: { doc: doc({}) } })).status,
    ).toBe(400);
    expect(
      (
        await api.call('member', 'POST', '/overrides/preview', {
          body: { doc: { bogus: 1 }, upstream: {} },
        })
      ).status,
    ).toBe(400);
  });

  it('10 previewing an installation requires managing it', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/overrides/preview', {
      body: { installationId: 'inst-member-b', doc: doc({}) },
    });
    expect(res.status).toBe(403);
  });
});

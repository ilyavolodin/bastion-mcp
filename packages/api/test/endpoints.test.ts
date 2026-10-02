import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const ids = (v: unknown): string[] => (rec(v).items as { id: string }[]).map((i) => i.id);
const etag = async (a: TestApi, url: string) =>
  String((await a.call('member', 'GET', url)).headers.etag);

describe('7.1 endpoints', () => {
  it('7.1 lists only your own endpoints', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'GET', '/endpoints');
    expect(ids(res.body)).toEqual(['ep-member-a']);
    expect(ids((await api.call('admin', 'GET', '/endpoints')).body)).toEqual([]);
  });

  it('7.1 other peoples endpoints do not exist for you', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/endpoints/ep-member-b')).status).toBe(404);
    expect(
      (await api.call('member', 'PATCH', '/endpoints/ep-member-b', { body: { displayName: 'x' } }))
        .status,
    ).toBe(404);
    expect((await api.call('member', 'DELETE', '/endpoints/ep-member-b')).status).toBe(404);
  });

  it('7.1 creates an endpoint over installations you can manage, with a unique slug', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/endpoints', {
      body: { slug: 'side', displayName: 'Side', installationIds: ['inst-member-a'] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ownerId: 'user-member-a', prefixMode: 'always' });
    expect(api.uow.audits.at(-1)?.action).toBe('endpoint.create');
    const dup = await api.call('member', 'POST', '/endpoints', {
      body: { slug: 'work', displayName: 'W' },
    });
    expect(dup.status).toBe(409);
    expect(rec(dup.body).code).toBe('slug_collision');
  });

  it('7.1 rejects installations the caller cannot use and invalid slugs', async () => {
    api = await buildTestApi();
    const foreign = await api.call('member', 'POST', '/endpoints', {
      body: { slug: 'x1', displayName: 'X', installationIds: ['inst-member-b'] },
    });
    expect(foreign.status).toBe(400);
    expect(rec(foreign.body).code).toBe('validation_failed');
    const missing = await api.call('member', 'POST', '/endpoints', {
      body: { slug: 'x2', displayName: 'X', installationIds: ['nope'] },
    });
    expect(missing.status).toBe(400);
    const bad = await api.call('member', 'POST', '/endpoints', {
      body: { slug: 'Bad_Slug!', displayName: 'X' },
    });
    expect(bad.status).toBe(400);
  });

  it('17.1 PATCH and DELETE need If-Match', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('member', 'PATCH', '/endpoints/ep-member-a', { body: { displayName: 'x' } }))
        .status,
    ).toBe(428);
    const tag = await etag(api, '/endpoints/ep-member-a');
    const patched = await api.call('member', 'PATCH', '/endpoints/ep-member-a', {
      headers: { 'if-match': tag },
      body: { displayName: 'Renamed', slug: 'renamed', installationIds: [] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ displayName: 'Renamed', slug: 'renamed' });
    const bad = await api.call('member', 'PATCH', '/endpoints/ep-member-a', {
      headers: { 'if-match': String(patched.headers.etag) },
      body: { installationIds: ['inst-member-b'] },
    });
    expect(bad.status).toBe(400);
    const del = await api.call('member', 'DELETE', '/endpoints/ep-member-a', {
      headers: { 'if-match': String(patched.headers.etag) },
    });
    expect(del.status).toBe(204);
    expect(api.uow.audits.at(-1)?.action).toBe('endpoint.delete');
  });

  it('7.1 a renamed slug may not collide with another of your endpoints', async () => {
    api = await buildTestApi();
    await api.call('member', 'POST', '/endpoints', { body: { slug: 'other', displayName: 'O' } });
    const tag = await etag(api, '/endpoints/ep-member-a');
    const res = await api.call('member', 'PATCH', '/endpoints/ep-member-a', {
      headers: { 'if-match': tag },
      body: { slug: 'other' },
    });
    expect(res.status).toBe(409);
  });
});

describe('11.4 endpoint client configuration', () => {
  it('11.4 returns configuration for each supported client', async () => {
    api = await buildTestApi();
    for (const client of ['claude-desktop', 'claude-code', 'cursor', 'vscode']) {
      const res = await api.call('member', 'GET', '/endpoints/ep-member-a/client-config', {
        query: { client },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        client,
        url: 'https://bastion.test/mcp/e/work',
        auth: 'oauth',
      });
    }
  });

  it('11.4 supports PAT mode and rejects unknown clients and foreign endpoints', async () => {
    api = await buildTestApi();
    const pat = await api.call('member', 'GET', '/endpoints/ep-member-a/client-config', {
      query: { client: 'claude-code', auth: 'pat' },
    });
    expect(rec(pat.body).command).toContain('Authorization: Bearer');
    expect(
      (
        await api.call('member', 'GET', '/endpoints/ep-member-a/client-config', {
          query: { client: 'emacs' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.call('member', 'GET', '/endpoints/ep-member-b/client-config', {
          query: { client: 'cursor' },
        })
      ).status,
    ).toBe(404);
  });
});

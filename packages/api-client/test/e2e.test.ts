import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from '../../api/test/helpers/harness';
import { ApiProblemError, createApiClient, etagOf, paginate } from '../src';

let api: TestApi;

/** `fetch` that serves requests straight from the Fastify app (no sockets). */
const injectFetch = (token: string): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await api.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const noBody = response.statusCode === 204 || response.body === '';
    return new Response(noBody ? null : response.body, {
      status: response.statusCode,
      headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, String(v)])),
    });
  }) as typeof fetch;

beforeAll(async () => {
  api = await buildTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('17 api client against the real API', () => {
  it('17 reads /me with the typed client', async () => {
    const client = createApiClient({
      baseUrl: 'https://bastion.test',
      fetch: injectFetch('tok-admin'),
    });
    const res = await client.get('/me');
    expect(res.data.id).toBe('user-admin');
    expect(res.data.orgRole).toBe('admin');
    expect(res.etag).toBeDefined();
  });

  it('17.1 iterates every page of a list', async () => {
    const client = createApiClient({
      baseUrl: 'https://bastion.test',
      fetch: injectFetch('tok-admin'),
    });
    const ids: string[] = [];
    for await (const user of paginate((cursor) =>
      client.get('/users', { query: { limit: 2, ...(cursor ? { cursor } : {}) } }),
    )) {
      ids.push(user.id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('17.1 updates with If-Match from the ETag and reports a stale write as a problem', async () => {
    const client = createApiClient({
      baseUrl: 'https://bastion.test',
      fetch: injectFetch('tok-admin'),
    });
    const before = await client.get('/users/{id}', { path: { id: 'user-member-b' } });
    const updated = await client.patch('/users/{id}', {
      path: { id: 'user-member-b' },
      body: { displayName: 'Via client' },
      ifMatch: before.etag ?? etagOf(before.data),
    });
    expect(updated.data.displayName).toBe('Via client');
    const stale = await client
      .patch('/users/{id}', {
        path: { id: 'user-member-b' },
        body: { displayName: 'Again' },
        ifMatch: before.etag ?? '',
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ApiProblemError);
    expect((stale as ApiProblemError).status).toBe(412);
    expect((stale as ApiProblemError).code).toBe('precondition_failed');
  });

  it('17.1 replays an Idempotency-Key and surfaces authorization failures as problems', async () => {
    const admin = createApiClient({
      baseUrl: 'https://bastion.test',
      fetch: injectFetch('tok-admin'),
    });
    const body = { email: 'client@example.com', displayName: 'Client', orgRole: 'member' as const };
    const first = await admin.post('/users', { body, idempotencyKey: 'abc' });
    const again = await admin.post('/users', { body, idempotencyKey: 'abc' });
    expect(again.data.id).toBe(first.data.id);
    const member = createApiClient({
      baseUrl: 'https://bastion.test',
      fetch: injectFetch('tok-member'),
    });
    const denied = (await member
      .post('/users', { body })
      .catch((e: unknown) => e)) as ApiProblemError;
    expect(denied.status).toBe(403);
    expect(denied.code).toBe('forbidden');
  });
});

import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/mocks/server';
import { ApiError, api, buildQuery, configureApi, fetchAll, readCookie } from './client';

const problem = (status: number, body: Record<string, unknown>) =>
  HttpResponse.json(
    { status, ...body },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

describe('api client (17.1, 9.2)', () => {
  it('9.2 sends the CSRF header from the cookie on state-changing calls only', async () => {
    const seen: Record<string, string | null> = {};
    server.use(
      http.get('*/api/v1/teams', ({ request }) => {
        seen.get = request.headers.get('x-bastion-csrf');
        return HttpResponse.json({});
      }),
      http.post('*/api/v1/teams', ({ request }) => {
        seen.post = request.headers.get('x-bastion-csrf');
        return HttpResponse.json({});
      }),
    );
    await api.get('/teams');
    await api.post('/teams', { slug: 'platform', displayName: 'Platform' });
    expect(seen.get).toBeNull();
    expect(seen.post).toBe('test-csrf');
  });

  it('17.1 turns problem+json into ApiError with field errors', async () => {
    server.use(
      http.post('*/api/v1/teams', () =>
        problem(422, {
          title: 'Invalid',
          code: 'validation_failed',
          detail: 'Bad',
          errors: [{ path: 'name', message: 'Required' }],
        }),
      ),
    );
    const err = await api
      .post('/teams', { slug: 'platform', displayName: 'Platform' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'validation_failed',
      errors: [{ path: 'name', message: 'Required' }],
    });
  });

  it('17.1 remembers the ETag from a GET and sends it as If-Match', async () => {
    let match: string | null = null;
    server.use(
      http.get('*/api/v1/settings', () => HttpResponse.json({}, { headers: { ETag: '"v7"' } })),
      http.patch('*/api/v1/settings', ({ request }) => {
        match = request.headers.get('if-match');
        return HttpResponse.json({});
      }),
    );
    await api.get('/settings');
    await api.patch('/settings', { personalInstalls: 'all' });
    expect(match).toBe('"v7"');
  });

  it('17.1 maps 412 to a conflict error', async () => {
    server.use(
      http.put('*/api/v1/settings/model-guards', () => problem(412, { title: 'Precondition' })),
    );
    const err = (await api
      .put('/settings/model-guards', { jev: null, llmJudge: null, classifier: null })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.isConflict).toBe(true);
  });

  it('redirects to login on 401', async () => {
    const onUnauthorized = vi.fn();
    configureApi({ onUnauthorized });
    server.use(http.get('*/api/v1/drift-reviews', () => problem(401, { title: 'Nope' })));
    await api.get('/drift-reviews').catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalled();
    configureApi({ onUnauthorized: () => undefined });
  });

  it('17.1 follows nextCursor until it is null', async () => {
    server.use(
      http.get('*/api/v1/users', ({ request }) => {
        const c = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(
          c ? { items: [3], nextCursor: null } : { items: [1, 2], nextCursor: 'n' },
        );
      }),
    );
    expect(await fetchAll('/users')).toEqual([1, 2, 3]);
  });

  it('reports a timeout and network failures with stable codes', async () => {
    server.use(
      http.get('*/api/v1/system/status', async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({});
      }),
    );
    const t = (await api
      .get('/system/status', { timeoutMs: 20 })
      .catch((e: unknown) => e)) as ApiError;
    expect(t.code).toBe('timeout');
    server.use(http.get('*/api/v1/system/status', () => HttpResponse.error()));
    const n = (await api.get('/system/status').catch((e: unknown) => e)) as ApiError;
    expect(n.code).toBe('network');
  });

  it('helpers', () => {
    expect(buildQuery({ a: 1, b: undefined, c: ['x', 'y'], d: '' })).toBe('?a=1&c=x&c=y');
    expect(readCookie('k', 'a=1; k=v%20w')).toBe('v w');
  });
});

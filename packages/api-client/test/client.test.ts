import { describe, expect, it } from 'vitest';
import { type ApiProblemError, createApiClient, etagOf, isApiProblemError, paginate } from '../src';

type Call = { url: string; init: RequestInit };

const recorder = (
  respond: (call: Call) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const headersOf = (call: Call): Record<string, string> =>
  call.init.headers as Record<string, string>;

describe('17 api client: requests', () => {
  it('17 appends /api/v1, fills path parameters and builds the query string', async () => {
    const r = recorder(() => json(200, { items: [], nextCursor: null }));
    const client = createApiClient({ baseUrl: 'https://bastion.test', fetch: r.fetch });
    await client.get('/users', { query: { limit: 10, q: 'ann marie' } });
    expect(r.calls[0]?.url).toBe('https://bastion.test/api/v1/users?limit=10&q=ann+marie');
    await client.get('/users/{id}', { path: { id: 'a/b c' } });
    expect(r.calls[1]?.url).toBe('https://bastion.test/api/v1/users/a%2Fb%20c');
  });

  it('17 keeps a base URL that already ends in /api/v1', async () => {
    const r = recorder(() => json(200, {}));
    const client = createApiClient({ baseUrl: 'https://bastion.test/api/v1/', fetch: r.fetch });
    await client.get('/me');
    expect(r.calls[0]?.url).toBe('https://bastion.test/api/v1/me');
  });

  it('9.2 sends the CSRF header on state-changing calls only', async () => {
    const r = recorder(() => json(200, {}));
    const client = createApiClient({
      baseUrl: 'https://b.test',
      fetch: r.fetch,
      csrf: () => 'csrf-1',
    });
    await client.get('/me');
    await client.patch('/me', { body: { displayName: 'A' } });
    expect(headersOf(r.calls[0] as Call)['x-bastion-csrf']).toBeUndefined();
    expect(headersOf(r.calls[1] as Call)['x-bastion-csrf']).toBe('csrf-1');
    expect(headersOf(r.calls[1] as Call)['content-type']).toBe('application/json');
    expect(r.calls[1]?.init.body).toBe('{"displayName":"A"}');
  });

  it('9.3 sends a bearer token when configured', async () => {
    const r = recorder(() => json(200, {}));
    const client = createApiClient({
      baseUrl: 'https://b.test',
      fetch: r.fetch,
      token: 'bst_pat_x',
    });
    await client.get('/me');
    expect(headersOf(r.calls[0] as Call).authorization).toBe('Bearer bst_pat_x');
  });

  it('17.1 sends If-Match and Idempotency-Key and returns the ETag', async () => {
    const r = recorder(() => json(200, { id: '1', updatedAt: 't' }, { etag: '"t"' }));
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const res = await client.patch('/users/{id}', {
      path: { id: '1' },
      body: { displayName: 'X' },
      ifMatch: etagOf({ updatedAt: 't0' }),
    });
    expect(headersOf(r.calls[0] as Call)['if-match']).toBe('"t0"');
    expect(res.etag).toBe('"t"');
    await client.post('/users', {
      body: { email: 'a@b.co', displayName: 'A', orgRole: 'member' },
      idempotencyKey: 'k1',
    });
    expect(headersOf(r.calls[1] as Call)['idempotency-key']).toBe('k1');
  });

  it('17 refuses a missing path parameter', async () => {
    const r = recorder(() => json(200, {}));
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    await expect(client.get('/users/{id}', { path: {} as { id: string } })).rejects.toThrow(
      /missing path parameter id/,
    );
  });

  it('17 handles empty 204 responses', async () => {
    const r = recorder(() => new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const res = await client.delete('/teams/{id}', { path: { id: 't' }, ifMatch: '"x"' });
    expect(res.status).toBe(204);
    expect(res.data).toBeUndefined();
  });
});

describe('17.1 api client: problem+json errors', () => {
  it('17.1 throws ApiProblemError carrying the problem document', async () => {
    const problem = {
      type: 'https://bastion-mcp.github.io/errors/validation_failed',
      title: 'Bad Request',
      status: 400,
      detail: 'the request is invalid',
      code: 'validation_failed',
      errors: [{ path: '/email', message: 'Invalid email' }],
    };
    const r = recorder(() => json(400, problem));
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const error = await client
      .post('/users', { body: { email: 'x', displayName: 'a', orgRole: 'member' } })
      .catch((e: unknown) => e);
    expect(isApiProblemError(error)).toBe(true);
    const problemError = error as ApiProblemError;
    expect(problemError.status).toBe(400);
    expect(problemError.code).toBe('validation_failed');
    expect(problemError.fieldErrors).toEqual([{ path: '/email', message: 'Invalid email' }]);
  });

  it('17.1 exposes the WWW-Authenticate challenge and the 412 conflict flag', async () => {
    const r = recorder((call) =>
      call.init.method === 'GET'
        ? json(
            401,
            {
              type: 't',
              title: 'Unauthorized',
              status: 401,
              detail: 'no',
              code: 'unauthenticated',
            },
            { 'www-authenticate': 'Bearer scope="api:read"' },
          )
        : json(412, {
            type: 't',
            title: 'Precondition Failed',
            status: 412,
            detail: 'stale',
            code: 'precondition_failed',
          }),
    );
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const unauth = (await client.get('/me').catch((e: unknown) => e)) as ApiProblemError;
    expect(unauth.wwwAuthenticate).toBe('Bearer scope="api:read"');
    const stale = (await client
      .patch('/me', { body: {}, ifMatch: '"old"' })
      .catch((e: unknown) => e)) as ApiProblemError;
    expect(stale.isConflict).toBe(true);
  });

  it('17.1 synthesizes a problem for non-problem failures', async () => {
    const r = recorder(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const error = (await client.get('/me').catch((e: unknown) => e)) as ApiProblemError;
    expect(error.code).toBe('http_error');
    expect(error.status).toBe(502);
    expect(error.problem.detail).toContain('bad gateway');
  });
});

describe('17.1 api client: pagination iterator', () => {
  it('17.1 follows nextCursor until it is null', async () => {
    const pages: Record<string, { items: Array<{ id: string }>; nextCursor: string | null }> = {
      first: { items: [{ id: '1' }, { id: '2' }], nextCursor: 'c2' },
      c2: { items: [{ id: '3' }], nextCursor: null },
    };
    const seen: Array<string | undefined> = [];
    const out: string[] = [];
    for await (const item of paginate(async (cursor) => {
      seen.push(cursor);
      const data = pages[cursor ?? 'first'] ?? { items: [], nextCursor: null };
      return { data, status: 200, etag: undefined, headers: new Headers() };
    })) {
      out.push(item.id);
    }
    expect(out).toEqual(['1', '2', '3']);
    expect(seen).toEqual([undefined, 'c2']);
  });

  it('17.1 stops after maxPages', async () => {
    let calls = 0;
    const out: number[] = [];
    for await (const n of paginate<number>(
      async () => {
        calls += 1;
        return {
          data: { items: [calls], nextCursor: 'more' },
          status: 200,
          etag: undefined,
          headers: new Headers(),
        };
      },
      { maxPages: 2 },
    )) {
      out.push(n);
    }
    expect(out).toEqual([1, 2]);
  });
});

describe('17 api client: problem parsing', () => {
  it('17.1 tolerates malformed error lists and non-JSON bodies', async () => {
    const r = recorder(() =>
      json(400, {
        type: 1,
        title: 'Bad',
        status: 'x',
        detail: 5,
        code: 'c',
        errors: [{ path: 1 }, { path: '/a', message: 'm' }],
      }),
    );
    const client = createApiClient({ baseUrl: 'https://b.test', fetch: r.fetch });
    const error = (await client.get('/me').catch((e: unknown) => e)) as ApiProblemError;
    expect(error.problem.type).toBe('about:blank');
    expect(error.problem.status).toBe(400);
    expect(error.fieldErrors).toEqual([{ path: '/a', message: 'm' }]);
    const text = recorder(() => new Response('not json', { status: 200 }));
    const ok = await createApiClient({ baseUrl: 'https://b.test', fetch: text.fetch }).get('/me');
    expect(ok.data).toBeUndefined();
  });
});

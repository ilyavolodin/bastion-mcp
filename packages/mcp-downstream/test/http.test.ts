import { AuthenticationError, InsufficientScopeError } from '@bastion-mcp/auth';
import { afterEach, describe, expect, it } from 'vitest';
import { challenge, type HttpStack, startHttpStack } from './helpers/http-stack';
import { rawLegacy, rawModern } from './helpers/raw';

let stack: HttpStack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});
const alice = (): string => stack?.users.alice?.token ?? '';

describe('9.3 6.9 authentication challenges', () => {
  it('6.9 a missing token is 401 with the exact WWW-Authenticate challenge', async () => {
    stack = await startHttpStack();
    const res = await rawModern(stack.base, { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(challenge(stack.base, 'invalid_token'));
  });

  it('6.9 an invalid token is 401 with resource_metadata and scope', async () => {
    stack = await startHttpStack();
    const res = await rawModern(stack.base, { token: 'nope', method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="');
    expect(res.headers.get('www-authenticate')).toContain('scope="mcp"');
  });

  it('6.9 insufficient scope is 403 with error="insufficient_scope"', async () => {
    stack = await startHttpStack({
      verifier: {
        verify: async () => {
          throw new InsufficientScopeError(
            'scope mcp required',
            'Bearer error="insufficient_scope", resource_metadata="http://x", scope="mcp"',
            'mcp',
          );
        },
      },
    });
    const res = await rawModern(stack.base, { token: 'x', method: 'tools/list' });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
  });

  it('6.9 a verifier outage is 503 with Retry-After, never a 500 with details', async () => {
    stack = await startHttpStack({
      verifier: {
        verify: async () => {
          throw new Error('redis exploded at 10.0.0.5');
        },
      },
    });
    const res = await rawModern(stack.base, { token: 'x', method: 'tools/list' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.text).not.toContain('10.0.0.5');
  });

  it('6.9 expired, revoked and wrong-audience tokens are the same 401 as an invalid one and reveal no reason', async () => {
    const reasons = ['expired', 'revoked', 'audience'];
    let index = 0;
    stack = await startHttpStack({
      verifier: {
        verify: async () => {
          throw new AuthenticationError(
            'INVALID_TOKEN',
            'invalid token',
            'Bearer error="invalid_token", scope="mcp"',
            reasons[index],
          );
        },
      },
    });
    for (index = 0; index < reasons.length; index += 1) {
      const res = await rawModern(stack.base, { token: 'x', method: 'tools/list' });
      expect(res.status).toBe(401);
      expect(res.text).not.toContain(reasons[index] ?? 'never');
    }
  });
});

describe('14.2 pre-auth flood limit', () => {
  it('14.2 429 with Retry-After before any parsing or authentication', async () => {
    stack = await startHttpStack({ flood: { mcpPerMinute: 3, oauthPerMinute: 60 } });
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof rawModern>> | undefined;
    for (let i = 0; i < 5; i += 1) {
      // No token at all: the first requests are 401, the later ones 429, so the limit runs first.
      last = await rawModern(stack.base, { method: 'tools/list' });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('14.2 a flooded client with an unparseable body still gets 429', async () => {
    stack = await startHttpStack({ flood: { mcpPerMinute: 1, oauthPerMinute: 60 } });
    await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    const res = await fetch(`${stack.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{{{',
    });
    expect(res.status).toBe(429);
  });
});

describe('7.1 Protected Resource Metadata', () => {
  it('7.1 every endpoint URL is its own resource and names the authorization servers', async () => {
    stack = await startHttpStack();
    for (const path of ['/mcp', '/mcp/e/work', '/mcp/i/github', '/mcp/c/github']) {
      const res = await fetch(`${stack.base}/.well-known/oauth-protected-resource${path}`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
      };
      expect(doc.resource).toBe(`${stack.base}${path}`);
      expect(doc.authorization_servers).toEqual([`${stack.base}/oauth`]);
      expect(doc.bearer_methods_supported).toEqual(['header']);
    }
  });

  it('7.1 unknown resource paths and bad slugs are 404', async () => {
    stack = await startHttpStack();
    for (const path of ['/mcp/x/y', '/mcp/i/BAD_SLUG', '/mcp/z/abc']) {
      expect(
        (await fetch(`${stack.base}/.well-known/oauth-protected-resource${path}`)).status,
      ).toBe(404);
    }
  });
});

describe('7.1 endpoint resolution', () => {
  it('7.1 unknown slugs, malformed slugs and unknown sub-paths are 404 for authenticated callers', async () => {
    stack = await startHttpStack();
    for (const path of [
      '/mcp/i/unknown',
      '/mcp/e/unknown',
      '/mcp/c/unknown',
      '/mcp/i/BAD',
      '/mcp/other',
      '/mcp/i/a/b',
    ]) {
      const res = await rawModern(stack.base, { token: alice(), path, method: 'tools/list' });
      expect(res.status).toBe(404);
    }
  });

  it('7.1 /mcp, /mcp/i/{slug} and a named /mcp/e/{slug} resolve; names are prefixed except on single-installation endpoints', async () => {
    stack = await startHttpStack({
      named: [
        { id: 'work', kind: 'named', slug: 'work', installationIds: [], prefixMode: 'always' },
      ],
    });
    const all = await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    expect(JSON.stringify(all.json?.result?.tools)).toContain('github__echo');
    const single = await rawModern(stack.base, {
      token: alice(),
      path: '/mcp/i/github',
      method: 'tools/list',
    });
    expect(JSON.stringify(single.json?.result?.tools)).toContain('"name":"echo"');
    const named = await rawModern(stack.base, {
      token: alice(),
      path: '/mcp/e/work',
      method: 'tools/list',
    });
    expect(named.status).toBe(200);
  });

  it('4.3 the effective endpoint is cached per principal: five requests, one cache entry', async () => {
    stack = await startHttpStack();
    for (let i = 0; i < 5; i += 1)
      await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    expect(stack.downstream.endpointCache.size).toBe(1);
  });

  it('4.3 a config event invalidates the cached endpoint', async () => {
    stack = await startHttpStack();
    await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    expect(stack.downstream.endpointCache.size).toBe(1);
    stack.downstream.endpointCache.invalidate({ scope: 'org', id: 'org' });
    expect(stack.downstream.endpointCache.size).toBe(0);
  });

  it('9.3 a PAT restricted to another endpoint is 403', async () => {
    stack = await startHttpStack({
      verifier: {
        verify: async () => ({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
          type: 'user',
          orgRole: 'member',
          teams: [],
          active: true,
          authMethod: 'pat',
          clientId: null,
          scopes: ['mcp'],
          endpointRestriction: 'i:something-else',
          credentialId: 'pat-1',
        }),
      },
    });
    const res = await rawModern(stack.base, { token: 'pat', method: 'tools/list' });
    expect(res.status).toBe(403);
  });
});

describe('6.2 transport-level rules', () => {
  it('6.2 a non-JSON POST is 415 after authentication; an unparseable JSON body is -32700', async () => {
    stack = await startHttpStack();
    const text = await fetch(`${stack.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice()}`, 'content-type': 'text/plain' },
      body: 'hi',
    });
    expect(text.status).toBe(415);
    const bad = await fetch(`${stack.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice()}`, 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('4.4 token verification runs before the content type and body are inspected', async () => {
    stack = await startHttpStack();
    const res = await fetch(`${stack.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
    });
    expect(res.status).toBe(401);
  });

  it('6.2 a request without a modern claim is served by the legacy adapter (initialize creates a session)', async () => {
    stack = await startHttpStack();
    const res = await rawLegacy(stack.base, {
      token: alice(),
      protocolVersion: '2025-06-18',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    expect(res.json?.result?.protocolVersion).toBe('2025-06-18');
  });

  it('6.2 modern requests are validated by the SDK: a missing Mcp-Method header is rejected', async () => {
    stack = await startHttpStack();
    const res = await rawModern(stack.base, {
      token: alice(),
      method: 'tools/list',
      headers: { 'mcp-method': '' },
    });
    expect(res.status).toBe(400);
  });

  it('6.2 GET goes to the legacy session handling and needs a session; unknown HTTP methods are 404', async () => {
    stack = await startHttpStack();
    const get = await rawLegacy(stack.base, {
      token: alice(),
      method: 'GET',
      body: undefined,
      headers: { accept: 'text/event-stream' },
    });
    expect(get.status).toBe(400);
    const put = await fetch(`${stack.base}/mcp`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${alice()}` },
    });
    expect(put.status).toBe(404);
  });

  it('6.9 Host and Origin validation rejects non-allowed values when configured', async () => {
    stack = await startHttpStack({
      config: { allowedHosts: ['127.0.0.1'], allowedOrigins: ['127.0.0.1'] },
    });
    const ok = await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    expect(ok.status).toBe(200);
    const evil = await rawModern(stack.base, {
      token: alice(),
      method: 'tools/list',
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.status).toBeGreaterThanOrEqual(400);
    expect(evil.status).toBeLessThan(500);
  });

  it('21.2 a draining worker answers 503 with Retry-After', async () => {
    stack = await startHttpStack();
    await stack.downstream.shutdown({ graceMs: 50 });
    const res = await rawModern(stack.base, { token: alice(), method: 'tools/list' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
  });
});

describe('7.1 25.8 /mcp/c/{catalogSlug}', () => {
  it('25.8 creates the installation on first use and tags call-log rows origin = plugin', async () => {
    const calls: { slug: string; created: boolean }[] = [];
    stack = await startHttpStack({
      catalogInstall: {
        ensure: async (_principal, slug) => {
          const created = calls.length === 0;
          calls.push({ slug, created });
          return { status: 'ok', created };
        },
      },
    });
    const first = await rawModern(stack.base, {
      token: alice(),
      path: '/mcp/c/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
    });
    expect(first.status).toBe(200);
    expect(calls).toEqual([{ slug: 'github', created: true }]);
    expect(stack.rows.at(-1)).toMatchObject({ method: 'tools/call', origin: 'plugin' });
    const regular = await rawModern(stack.base, {
      token: alice(),
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
    });
    expect(regular.status).toBe(200);
    expect((stack.rows.at(-1) as { origin?: string }).origin).toBeUndefined();
  });

  it('25.8 an entry the caller cannot see is 404, and so is /mcp/c/* without a catalog port', async () => {
    stack = await startHttpStack({
      catalogInstall: { ensure: async () => ({ status: 'not_found' }) },
    });
    expect(
      (await rawModern(stack.base, { token: alice(), path: '/mcp/c/github', method: 'tools/list' }))
        .status,
    ).toBe(404);
    const bare = await startHttpStack();
    expect(
      (
        await rawModern(bare.base, {
          token: bare.users.alice?.token ?? '',
          path: '/mcp/c/github',
          method: 'tools/list',
        })
      ).status,
    ).toBe(404);
    await bare.stop();
  });
});

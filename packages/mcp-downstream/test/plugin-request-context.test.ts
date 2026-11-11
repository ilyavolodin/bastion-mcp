import { buildPrincipal, type Principal } from '@bastion-mcp/auth';
import { sha256Hex } from '@bastion-mcp/core';
import { trace } from '@opentelemetry/api';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange } from '../src/adapters/contracts';
import { bastionRequestContext } from '../src/context';
import { type HttpDeps, registerMcpRoutes } from '../src/http/plugin';

const principal: Principal = buildPrincipal(
  { id: 'u1', type: 'user', orgRole: 'member', teams: [], active: true },
  { authMethod: 'oauth', clientId: 'client-1', scopes: ['mcp', 'extra'], credentialId: 'jti' },
);

type Seen = { adapter: string; exchange: Exchange; raw: unknown };

const BASE = 'https://bastion.example';

const stack = async (
  opts: { fail?: 'before-headers' | 'after-headers'; installations?: number } = {},
) => {
  const seen: Seen[] = [];
  const errors: unknown[][] = [];
  const verified: { authorization: string | undefined; url: string }[] = [];
  const resolveCalls: unknown[][] = [];
  const handle = (adapter: string) => async (exchange: Exchange) => {
    seen.push({ adapter, exchange, raw: (exchange.req as { auth?: unknown }).auth });
    if (opts.fail === 'before-headers') throw new Error('adapter boom');
    if (opts.fail === 'after-headers') {
      exchange.res.writeHead(200, { 'content-type': 'text/plain' });
      exchange.res.write('partial');
      throw new Error('adapter boom');
    }
    exchange.res.writeHead(200, { 'content-type': 'text/plain' });
    exchange.res.end(adapter);
  };
  const deps = {
    verifier: {
      verify: async (authorization: string | undefined, url: string) => {
        verified.push({ authorization, url });
        return principal;
      },
    },
    flood: { check: async () => ({ ok: true }) },
    resolver: {
      resolve: async (...args: unknown[]) => {
        resolveCalls.push(args);
        return {
          definition: { id: 'ep-1' },
          endpoint: {
            installations: Array.from({ length: opts.installations ?? 1 }, () => ({})),
          },
          installations: new Map(),
        };
      },
    },
    endpointCache: { invalidate: () => undefined },
    modern: {
      node: async (req: unknown, res: unknown, body: unknown) =>
        handle('modern')({
          req,
          res,
          body,
          rc: bastionRequestContext.getStore(),
        } as unknown as Exchange),
    },
    legacy: { handle: handle('legacy') },
    listen: { handle: handle('listen') },
    direct: { handle: handle('direct') },
    baseUrl: BASE,
    authorizationServers: [],
    tracer: trace.getTracer('test'),
    logger: {
      error: (...args: unknown[]) => void errors.push(args),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    },
    isDraining: () => false,
    track: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as HttpDeps;
  const app = Fastify({ logger: false });
  await registerMcpRoutes(app, deps);
  return { app, seen, errors, verified, resolveCalls };
};

let current: Awaited<ReturnType<typeof stack>> | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const post = (body: string, headers: Record<string, string> = {}, url = '/mcp') =>
  current?.app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json', ...headers },
  });

describe('6.2 the request context built for one /mcp exchange', () => {
  it('carries the principal, auth info, token hash, endpoint, url, path, ip, origin, headers and body', async () => {
    current = await stack();
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const res = await post(JSON.stringify(body), {}, '/mcp/i/github?x=1');
    expect(res?.statusCode).toBe(200);
    expect(res?.body).toBe('legacy');
    const seen = current.seen[0];
    if (!seen) throw new Error('no exchange reached an adapter');
    const { exchange, raw } = seen;
    const rc = exchange.rc;
    expect(rc.principal).toBe(principal);
    expect(rc.authInfo).toEqual({ token: 'tok-1', clientId: 'client-1', scopes: ['mcp', 'extra'] });
    expect(rc.authInfo.scopes).not.toBe(principal.scopes);
    expect(rc.tokenHash).toBe(sha256Hex('tok-1'));
    expect(rc.endpointPath).toEqual({ kind: 'installation', slug: 'github' });
    expect(rc.requestUrl).toBe(`${BASE}/mcp/i/github?x=1`);
    expect(rc.path).toBe('/mcp/i/github');
    expect(rc.ip).toBe('127.0.0.1');
    expect(rc.origin).toBe('client');
    expect(rc.headers.authorization).toBe('Bearer tok-1');
    expect(rc.body).toEqual(body);
    expect('meta' in rc).toBe(false);
    expect(exchange.body).toEqual(body);
    expect(raw).toBe(rc.authInfo);
  });

  it('the verifier gets the Authorization header and the absolute request URL, and the resolver the plain path', async () => {
    current = await stack();
    await post('{}', {}, '/mcp/i/github?x=1');
    expect(current.verified).toEqual([
      { authorization: 'Bearer tok-1', url: `${BASE}/mcp/i/github?x=1` },
    ]);
    const [, parsed, request] = current.resolveCalls[0] ?? [];
    expect(parsed).toEqual({ kind: 'installation', slug: 'github' });
    expect(request).toEqual({
      clientId: 'client-1',
      clientName: '',
      ip: '127.0.0.1',
      authMethod: 'oauth',
      path: '/mcp/i/github',
    });
  });

  it('a trailing slash never reaches the handler: it is the wildcard 404, after verification', async () => {
    current = await stack();
    const res = await post('{}', {}, '/mcp/');
    expect(res?.statusCode).toBe(404);
    expect(res?.json()).toEqual({ error: 'not_found' });
    expect(current.verified).toHaveLength(1);
    expect(current.seen).toEqual([]);
  });

  it('params._meta is the context meta only when it is an object', async () => {
    current = await stack();
    await post(JSON.stringify({ params: { _meta: { a: 1 } } }));
    await post(JSON.stringify({ params: { _meta: 'x' } }));
    await post(JSON.stringify({ params: { _meta: [1] } }));
    await post('null');
    const metas = current.seen.map((s) => s.exchange.rc.meta);
    expect(metas[0]).toEqual({ a: 1 });
    expect(metas[1]).toBeUndefined();
    expect(metas[2]).toBeUndefined();
    expect(metas[3]).toBeUndefined();
  });

  it('a JSON null body is the body; GET has no body key at all', async () => {
    current = await stack();
    await post('null');
    expect('body' in (current.seen[0]?.exchange.rc ?? {})).toBe(true);
    expect(current.seen[0]?.exchange.rc.body).toBeNull();
    await current.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer tok-1' },
    });
    const get = current.seen[1];
    expect(get?.adapter).toBe('legacy');
    expect('body' in (get?.exchange.rc ?? {})).toBe(false);
    expect(get?.exchange.body).toBeUndefined();
  });

  it('the bearer token is empty without a Bearer scheme, and the hash is of the empty string', async () => {
    current = await stack();
    await post('{}', { authorization: 'Basic abc' });
    const rc = current.seen[0]?.exchange.rc;
    expect(rc?.authInfo.token).toBe('');
    expect(rc?.tokenHash).toBe(sha256Hex(''));
  });

  it('the endpoint origin is plugin for /mcp/c/{slug} only when a catalog port exists (404 otherwise)', async () => {
    current = await stack();
    const res = await post('{}', {}, '/mcp/c/github');
    expect(res?.statusCode).toBe(404);
    expect(res?.json()).toEqual({ error: 'not_found' });
    expect(current.seen).toEqual([]);
  });

  it('dispatch: subscriptions/listen, a modern claim with tasks, and the rest', async () => {
    current = await stack();
    await post('{}', { 'mcp-method': 'subscriptions/listen' });
    await post('{}', { 'mcp-method': 'tasks/get' });
    await post('{}', {});
    expect(current.seen.map((s) => s.adapter)).toEqual(['listen', 'direct', 'modern']);
    await current.app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { authorization: 'Bearer tok-1' },
    });
    expect(current.seen.map((s) => s.adapter)).toEqual(['listen', 'direct', 'modern', 'legacy']);
  });
});

describe('6.2 4.4 answers before and after dispatch', () => {
  it('a non-JSON POST is 415 with an invalid-request body, after authentication', async () => {
    current = await stack();
    const res = await post('hi', { 'content-type': 'text/plain' });
    expect(res?.statusCode).toBe(415);
    expect(res?.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Unsupported Media Type: Content-Type must be application/json',
      },
    });
    expect(current.verified).toHaveLength(1);
    expect(current.seen).toEqual([]);
  });

  it('unparseable JSON is 400 with a parse error', async () => {
    current = await stack();
    const res = await post('{nope');
    expect(res?.statusCode).toBe(400);
    expect(res?.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('an empty POST body is a parse error too', async () => {
    current = await stack();
    const res = await post('');
    expect(res?.statusCode).toBe(400);
    expect(res?.json().error.code).toBe(-32700);
  });

  it('the content type check is case-insensitive and accepts parameters', async () => {
    current = await stack();
    const res = await post('{}', { 'content-type': 'Application/JSON; charset=utf-8' });
    expect(res?.statusCode).toBe(200);
  });

  it('a GET is not checked for a content type or body', async () => {
    current = await stack();
    const res = await current.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer tok-1', 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unknown paths and empty single-installation endpoints are 404 after verification', async () => {
    current = await stack({ installations: 0 });
    const unknown = await post('{}', {}, '/mcp/zzz/github');
    expect(unknown?.statusCode).toBe(404);
    expect(unknown?.json()).toEqual({ error: 'not_found' });
    expect(current.verified).toEqual([]);
    const empty = await post('{}', {}, '/mcp/i/github');
    expect(empty?.statusCode).toBe(404);
    expect(current.verified).toHaveLength(1);
    const root = await post('{}', {}, '/mcp');
    expect(root?.statusCode).toBe(200);
  });

  it('an adapter that throws before writing gets a JSON-RPC internal error with status 500, logged', async () => {
    current = await stack({ fail: 'before-headers' });
    const res = await post('{}');
    expect(res?.statusCode).toBe(500);
    expect(res?.headers['content-type']).toBe('application/json');
    expect(res?.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
    expect(current.errors).toEqual([['mcp exchange failed', { error: 'Error: adapter boom' }]]);
  });

  it('an adapter that throws after the headers were sent just ends the response', async () => {
    current = await stack({ fail: 'after-headers' });
    const res = await post('{}');
    expect(res?.statusCode).toBe(200);
    expect(res?.body).toBe('partial');
    expect(current.errors).toHaveLength(1);
  });
});

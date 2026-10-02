import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authz,
  defineMutation,
  defineRoute,
  defineStream,
  type RouteDefinition,
} from '../src/framework/route';
import { RouteDeclarationError } from '../src/framework/route-table';
import { itemSchema } from '../src/schemas/common';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const newUser = (email: string) => ({ email, displayName: 'New User', orgRole: 'member' });
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('17.1 errors: RFC 9457 problem+json', () => {
  it('17.1 answers 401 with a problem document and the WWW-Authenticate challenge', async () => {
    api = await buildTestApi();
    const res = await api.call('anonymous', 'GET', '/users');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(String(res.headers['www-authenticate'])).toContain('Bearer');
    expect(res.body).toMatchObject({
      type: 'https://bastion-mcp.github.io/errors/unauthenticated',
      status: 401,
      code: 'unauthenticated',
      title: 'Unauthorized',
    });
  });

  it('17.1 reports validation failures with an errors[] list', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', { body: { email: 'nope' } });
    expect(res.status).toBe(400);
    const body = asRecord(res.body);
    expect(body.code).toBe('validation_failed');
    expect(body.type).toBe('https://bastion-mcp.github.io/errors/validation_failed');
    expect(Array.isArray(body.errors)).toBe(true);
    expect((body.errors as unknown[]).length).toBeGreaterThan(0);
  });

  it('17.1 answers unknown routes with a 404 problem', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/nope');
    expect(res.status).toBe(404);
    expect(asRecord(res.body).code).toBe('not_found');
  });

  it('22 never leaks the message of an unexpected error', async () => {
    const boom: RouteDefinition = defineRoute({
      method: 'GET',
      url: '/users',
      tag: 't',
      summary: 'boom',
      schema: { response: z.object({}) },
      authz: authz.on('org.view', () => ({ type: 'Org' })),
      handler: () => {
        throw new Error('secret internals');
      },
    });
    api = await buildTestApi({ routes: [boom] });
    const res = await api.call('admin', 'GET', '/users');
    expect(res.status).toBe(500);
    expect(res.raw).not.toContain('secret internals');
  });
});

describe('17.1 authentication', () => {
  it('9.2 accepts a browser session cookie for reads', async () => {
    api = await buildTestApi();
    const res = await api.call('anonymous', 'GET', '/users', {
      headers: { cookie: 'bastion_sid=sid-admin' },
    });
    expect(res.status).toBe(200);
  });

  it('9.2 requires the CSRF header on state-changing calls made with a session', async () => {
    api = await buildTestApi();
    const cookie = 'bastion_sid=sid-admin; bastion_csrf=abc';
    const denied = await api.call('anonymous', 'POST', '/users', {
      headers: { cookie },
      body: newUser('csrf@example.com'),
    });
    expect(denied.status).toBe(403);
    expect(asRecord(denied.body).code).toBe('csrf_failed');
    const ok = await api.call('anonymous', 'POST', '/users', {
      headers: { cookie, 'x-bastion-csrf': 'abc' },
      body: newUser('csrf@example.com'),
    });
    expect(ok.status).toBe(201);
  });

  it('17.1 does not require CSRF for bearer tokens', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', { body: newUser('bearer@example.com') });
    expect(res.status).toBe(201);
  });

  it('9.3 a token with only api:read cannot call state-changing routes', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', {
      headers: { authorization: 'Bearer tok-admin:read' },
      body: newUser('ro@example.com'),
    });
    expect(res.status).toBe(403);
    expect(asRecord(res.body).code).toBe('insufficient_scope');
    expect(String(res.headers['www-authenticate'])).toContain('insufficient_scope');
    const read = await api.call('admin', 'GET', '/users', {
      headers: { authorization: 'Bearer tok-admin:read' },
    });
    expect(read.status).toBe(200);
  });

  it('9.3 rejects an invalid token with 401', async () => {
    api = await buildTestApi();
    const res = await api.call('anonymous', 'GET', '/users', {
      headers: { authorization: 'Bearer junk' },
    });
    expect(res.status).toBe(401);
  });
});

describe('17.1 pagination, filtering and sorting', () => {
  it('17.1 returns {items, nextCursor} and follows the cursor', async () => {
    api = await buildTestApi();
    const first = await api.call('admin', 'GET', '/users', { query: { limit: '2' } });
    expect(first.status).toBe(200);
    const page = asRecord(first.body);
    expect((page.items as unknown[]).length).toBe(2);
    expect(typeof page.nextCursor).toBe('string');
    const second = await api.call('admin', 'GET', '/users', {
      query: { limit: '2', cursor: String(page.nextCursor) },
    });
    const secondPage = asRecord(second.body);
    const ids = [
      ...(page.items as { id: string }[]),
      ...(secondPage.items as { id: string }[]),
    ].map((i) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('17.1 ends with nextCursor null and defaults limit to 50', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/users');
    const body = asRecord(res.body);
    expect(body.nextCursor).toBeNull();
    expect((body.items as unknown[]).length).toBe(6);
  });

  it('17.1 caps limit at 500', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'GET', '/users', { query: { limit: '500' } })).status).toBe(
      200,
    );
    expect((await api.call('admin', 'GET', '/users', { query: { limit: '501' } })).status).toBe(
      400,
    );
    expect((await api.call('admin', 'GET', '/users', { query: { limit: '0' } })).status).toBe(400);
  });

  it('17.1 supports ?q= text search and ?sort=-field', async () => {
    api = await buildTestApi();
    const q = await api.call('admin', 'GET', '/users', { query: { q: 'auditor' } });
    expect((asRecord(q.body).items as unknown[]).length).toBe(1);
    const sorted = await api.call('admin', 'GET', '/users', { query: { sort: '-email' } });
    const emails = (asRecord(sorted.body).items as { email: string }[]).map((u) => u.email);
    expect(emails).toEqual([...emails].sort().reverse());
    expect(
      (await api.call('admin', 'GET', '/users', { query: { sort: 'bad field!' } })).status,
    ).toBe(400);
  });
});

describe('17.1 concurrency: ETag and If-Match', () => {
  it('17.1 returns an ETag derived from updated_at', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'GET', '/users/user-member-a');
    const row = await api.store.get('users', 'user-member-a');
    expect(res.headers.etag).toBe(`"${row?.updatedAt}"`);
  });

  it('17.1 answers 428 when If-Match is missing on PATCH, PUT and DELETE', async () => {
    api = await buildTestApi();
    const patch = await api.call('admin', 'PATCH', '/users/user-member-a', {
      body: { displayName: 'X' },
    });
    expect(patch.status).toBe(428);
    expect(asRecord(patch.body).code).toBe('precondition_required');
    const put = await api.call('admin', 'PUT', '/teams/team-a/members/user-member-a', {
      body: { role: 'manager' },
    });
    expect(put.status).toBe(428);
    const del = await api.call('admin', 'DELETE', '/teams/team-b');
    expect(del.status).toBe(428);
  });

  it('17.1 answers 412 on a stale If-Match and applies the change on a fresh one', async () => {
    api = await buildTestApi();
    const stale = await api.call('admin', 'PATCH', '/users/user-member-a', {
      headers: { 'if-match': '"1999-01-01T00:00:00.000Z"' },
      body: { displayName: 'X' },
    });
    expect(stale.status).toBe(412);
    const current = await api.call('admin', 'GET', '/users/user-member-a');
    const fresh = await api.call('admin', 'PATCH', '/users/user-member-a', {
      headers: { 'if-match': String(current.headers.etag) },
      body: { displayName: 'Renamed' },
    });
    expect(fresh.status).toBe(200);
    expect(asRecord(fresh.body).displayName).toBe('Renamed');
    expect(fresh.headers.etag).not.toBe(current.headers.etag);
    const replayStale = await api.call('admin', 'PATCH', '/users/user-member-a', {
      headers: { 'if-match': String(current.headers.etag) },
      body: { displayName: 'Again' },
    });
    expect(replayStale.status).toBe(412);
  });

  it('17.1 accepts If-Match: * and weak validators', async () => {
    api = await buildTestApi();
    const star = await api.call('admin', 'PATCH', '/users/user-member-a', {
      headers: { 'if-match': '*' },
      body: { displayName: 'Star' },
    });
    expect(star.status).toBe(200);
    const current = await api.call('admin', 'GET', '/users/user-member-a');
    const weak = await api.call('admin', 'PATCH', '/users/user-member-a', {
      headers: { 'if-match': `W/${String(current.headers.etag)}` },
      body: { displayName: 'Weak' },
    });
    expect(weak.status).toBe(200);
  });

  it('17.1 a missing resource is 404, not 428', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'PATCH', '/users/nobody', { body: { displayName: 'X' } });
    expect(res.status).toBe(404);
  });
});

describe('17.1 idempotency', () => {
  it('17.1 replays the original response for the same Idempotency-Key within 24 h', async () => {
    api = await buildTestApi();
    const headers = { 'idempotency-key': 'key-1' };
    const first = await api.call('admin', 'POST', '/users', {
      headers,
      body: newUser('idem@example.com'),
    });
    const second = await api.call('admin', 'POST', '/users', {
      headers,
      body: newUser('idem@example.com'),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    const users = await api.store.find('users', { email: 'idem@example.com' });
    expect(users).toHaveLength(1);
    expect(await api.redis.get('idem:user-admin:key-1')).not.toBeNull();
  });

  it('17.1 rejects the same key with a different request (422)', async () => {
    api = await buildTestApi();
    const headers = { 'idempotency-key': 'key-2' };
    await api.call('admin', 'POST', '/users', { headers, body: newUser('one@example.com') });
    const clash = await api.call('admin', 'POST', '/users', {
      headers,
      body: newUser('two@example.com'),
    });
    expect(clash.status).toBe(422);
    expect(asRecord(clash.body).code).toBe('idempotency_key_reuse');
  });

  it('17.1 scopes keys per principal and does not store failures', async () => {
    api = await buildTestApi();
    const headers = { 'idempotency-key': 'key-3' };
    const bad = await api.call('admin', 'POST', '/users', { headers, body: { email: 'bad' } });
    expect(bad.status).toBe(400);
    expect(await api.redis.get('idem:user-admin:key-3')).toBeNull();
    const good = await api.call('admin', 'POST', '/users', {
      headers,
      body: newUser('three@example.com'),
    });
    expect(good.status).toBe(201);
    const denied = await api.call('member', 'POST', '/users', {
      headers,
      body: newUser('three@example.com'),
    });
    expect(denied.status).toBe(403);
  });

  it('17.1 rejects an invalid Idempotency-Key', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', {
      headers: { 'idempotency-key': 'x'.repeat(300) },
      body: newUser('long@example.com'),
    });
    expect(res.status).toBe(400);
  });
});

describe('17.1 audit in the same transaction', () => {
  it('17.1 writes an audit event with the actor for every mutating route', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', { body: newUser('audit@example.com') });
    expect(res.status).toBe(201);
    expect(api.uow.audits).toHaveLength(1);
    expect(api.uow.audits[0]).toMatchObject({
      action: 'user.create',
      targetType: 'user',
      targetId: asRecord(res.body).id,
      actorType: 'user',
      actorId: 'user-admin',
    });
  });

  it('17.1 rolls the change back when the transaction fails (no row, no audit)', async () => {
    api = await buildTestApi();
    const first = await api.call('admin', 'POST', '/users', { body: newUser('dup@example.com') });
    expect(first.status).toBe(201);
    const auditsBefore = api.uow.audits.length;
    const dup = await api.call('admin', 'POST', '/users', { body: newUser('dup@example.com') });
    expect(dup.status).toBe(409);
    expect(api.uow.audits).toHaveLength(auditsBefore);
  });

  it('17.1 fails a mutating route that wrote no audit event', async () => {
    const silent: RouteDefinition = defineMutation({
      method: 'POST',
      url: '/users',
      tag: 't',
      summary: 'silent',
      schema: { response: itemSchema },
      authz: authz.on('users.write', () => ({ type: 'Org' })),
      handler: async (ctx) => ctx.tx.store.insert('users', { email: 'silent@example.com' }),
    });
    api = await buildTestApi({ routes: [silent] });
    const res = await api.call('admin', 'POST', '/users');
    expect(res.status).toBe(500);
    expect(await api.store.find('users', { email: 'silent@example.com' })).toHaveLength(0);
  });

  it('4.3 publishes bastion:config only after commit', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', '/users', { body: newUser('cfg@example.com') });
    expect(api.publisher.messages).toEqual([
      { channel: 'bastion:config', message: '{"topic":"users"}' },
    ]);
    await api.call('admin', 'POST', '/users', { body: newUser('cfg@example.com') });
    expect(api.publisher.messages).toHaveLength(1);
  });
});

describe('10 authorization declarations', () => {
  const base = {
    tag: 't',
    summary: 's',
    schema: { response: z.object({}) },
    handler: () => ({}),
  } as const;

  it('10 refuses to start when a route has no authorization declaration', async () => {
    const missing = {
      method: 'GET',
      url: '/users',
      ...base,
      mutates: false,
      stream: false,
      status: 200,
    } as unknown as RouteDefinition;
    await expect(buildTestApi({ routes: [missing] })).rejects.toThrow(RouteDeclarationError);
  });

  it('10 refuses to start when a route names an unknown rule', async () => {
    const route = defineRoute({
      method: 'GET',
      url: '/users',
      ...base,
      authz: authz.on('nope', () => ({ type: 'Org' })),
    });
    await expect(buildTestApi({ routes: [route] })).rejects.toThrow(/unknown authorization rule/);
  });

  it('10 refuses to start when a route is not listed under its rule in ROUTE_ACTIONS', async () => {
    const route = defineRoute({
      method: 'GET',
      url: '/not-in-the-table',
      ...base,
      authz: authz.on('org.view', () => ({ type: 'Org' })),
    });
    await expect(buildTestApi({ routes: [route] })).rejects.toThrow(/not listed/);
  });

  it('10 refuses duplicate routes', async () => {
    const route = defineRoute({
      method: 'GET',
      url: '/users',
      ...base,
      authz: authz.on('org.view', () => ({ type: 'Org' })),
    });
    await expect(buildTestApi({ routes: [route, route] })).rejects.toThrow(/twice/);
  });

  it('10 authorizes before validating the body (a denied caller sees 403, not 400)', async () => {
    api = await buildTestApi();
    const res = await api.call('member', 'POST', '/users', { body: { garbage: true } });
    expect(res.status).toBe(403);
    expect(asRecord(res.body).code).toBe('forbidden');
  });

  it('10 authorizes before touching data (a denied caller cannot learn whether a row exists)', async () => {
    api = await buildTestApi();
    const missing = await api.call('member', 'PATCH', '/users/does-not-exist', {
      body: { displayName: 'x' },
    });
    const present = await api.call('member', 'PATCH', '/users/user-admin', {
      body: { displayName: 'x' },
    });
    expect(missing.status).toBe(403);
    expect(present.status).toBe(403);
  });
});

describe('17 OpenAPI 3.1 document', () => {
  it('17 serves an OpenAPI 3.1 document generated from the zod route schemas', async () => {
    api = await buildTestApi();
    const res = await api.call('anonymous', 'GET', '/openapi.json');
    expect(res.status).toBe(200);
    const doc = asRecord(res.body);
    expect(doc.openapi).toBe('3.1.0');
    const paths = asRecord(doc.paths);
    expect(paths['/users']).toBeDefined();
    expect(paths['/users/{id}']).toBeDefined();
    const components = asRecord(doc.components);
    expect(asRecord(components.schemas).Problem).toBeDefined();
    expect(asRecord(components.securitySchemes).bearer).toBeDefined();
    const patch = asRecord(asRecord(paths['/users/{id}']).patch);
    expect(asRecord(patch.responses)['412']).toBeDefined();
    expect(asRecord(patch.responses)['428']).toBeDefined();
  });
});

describe('18.1 server-sent events', () => {
  it('18.1 streams text/event-stream frames and runs the cleanup when the source ends', async () => {
    let cleaned = false;
    const route = defineStream({
      url: '/events',
      tag: 't',
      summary: 'events',
      schema: {},
      authz: authz.self(),
      handler: () => ({
        initial: [{ event: 'hello', data: { n: 1 }, id: 'e1' }],
        subscribe: (emit, end) => {
          emit({ event: 'tick', data: 'two' });
          setTimeout(end, 5);
          return () => {
            cleaned = true;
          };
        },
      }),
    });
    api = await buildTestApi({ routes: [route] });
    const res = await api.call('member', 'GET', '/events');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.raw).toBe('id: e1\nevent: hello\ndata: {"n":1}\n\nevent: tick\ndata: "two"\n\n');
    expect(cleaned).toBe(true);
  });

  it('18.1 authenticates stream routes like any other route', async () => {
    const route = defineStream({
      url: '/events',
      tag: 't',
      summary: 'events',
      schema: {},
      authz: authz.self(),
      handler: () => ({
        subscribe: (_emit, end) => {
          end();
          return () => {};
        },
      }),
    });
    api = await buildTestApi({ routes: [route] });
    expect((await api.call('anonymous', 'GET', '/events')).status).toBe(401);
  });
});

describe('17.1 malformed requests', () => {
  it('17.1 answers a malformed JSON body with a 400 problem, not a 500', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/users', {
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
    expect(res.status).toBe(400);
    const raw = await api.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.headers['content-type']).toContain('application/problem+json');
  });
});

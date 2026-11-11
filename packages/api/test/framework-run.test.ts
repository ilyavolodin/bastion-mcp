import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authz,
  defineMutation,
  defineRoute,
  type RouteDefinition,
  RouteReply,
} from '../src/framework/route';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const itemOut = z.object({ id: z.string(), updatedAt: z.string().optional() });
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

const readRoute = (
  handler: (calls: number) => unknown,
  extra: Partial<{ status: 200 | 201 | 202 | 204; response: z.ZodType | undefined }> = {},
): { def: RouteDefinition; calls: () => number } => {
  let calls = 0;
  const def = defineRoute({
    method: 'GET',
    url: '/me',
    tag: 't',
    summary: 'read',
    schema: { response: 'response' in extra ? (extra.response as z.ZodType) : itemOut },
    authz: authz.self(),
    ...(extra.status ? { status: extra.status } : {}),
    handler: (() => {
      calls += 1;
      return handler(calls);
    }) as never,
  });
  return { def, calls: () => calls };
};

const postRoute = (
  handler: (ctx: never) => unknown,
  options: { mutates: boolean; status?: 200 | 201 | 202 | 204 },
): { def: RouteDefinition; calls: () => number } => {
  let calls = 0;
  const wrapped = (ctx: never) => {
    calls += 1;
    return handler(ctx);
  };
  const common = {
    method: 'POST' as const,
    url: '/me/password',
    tag: 't',
    summary: 'post',
    schema: { response: itemOut },
    authz: authz.self(),
    ...(options.status ? { status: options.status } : {}),
  };
  const def = options.mutates
    ? defineMutation({ ...common, handler: wrapped as never })
    : defineRoute({ ...common, readOnly: true, handler: wrapped as never });
  return { def, calls: () => calls };
};

describe('17.1 route runner: reply serialization', () => {
  it('17.1 sends the parsed body as JSON with the default status and an ETag from updatedAt', async () => {
    const { def } = readRoute(() => ({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', extra: 1 }));
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers.etag).toBe('"2026-01-01T00:00:00.000Z"');
    expect(res.raw).toBe('{"id":"a","updatedAt":"2026-01-01T00:00:00.000Z"}');
  });

  it('17.1 sets no ETag when the body has no string updatedAt', async () => {
    const { def } = readRoute(() => ({ id: 'a' }));
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });

  it('17.1 a RouteReply overrides the status and adds its headers, still JSON', async () => {
    const { def } = readRoute(
      () => new RouteReply({ id: 'a' }, { status: 202, headers: { 'x-extra': 'yes' } }),
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(202);
    expect(res.headers['x-extra']).toBe('yes');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).toEqual({ id: 'a' });
  });

  it('17.1 a raw reply sends String(body) with the status and headers given, skipping the schema', async () => {
    const { def } = readRoute(
      () =>
        new RouteReply(12345, {
          raw: true,
          status: 201,
          headers: { 'content-type': 'text/plain', 'x-raw': '1' },
        }),
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(201);
    expect(res.raw).toBe('12345');
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.headers['x-raw']).toBe('1');
    expect(res.headers.etag).toBeUndefined();
  });

  it('17.1 answers 204 with no body when the status is 204, headers still applied', async () => {
    const { def } = readRoute(() => new RouteReply({ id: 'a' }, { headers: { 'x-h': 'v' } }), {
      status: 204,
    });
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
    expect(res.headers['x-h']).toBe('v');
  });

  it('17.1 a reply status of 204 wins over the route status', async () => {
    const { def } = readRoute(() => new RouteReply({ id: 'a' }, { status: 204 }));
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
  });

  it('17.1 a route without a response schema answers 204 whatever its status', async () => {
    const { def } = readRoute(() => ({ id: 'a' }), { response: undefined });
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(204);
    expect(res.raw).toBe('');
  });

  it('22 a body the response schema rejects is a 500 problem without the details', async () => {
    const { def } = readRoute(() => ({ nope: true }));
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'GET', '/me');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});

describe('17.1 route runner: idempotency on a POST', () => {
  it('17.1 saves a 2xx JSON reply with its ETag and replays it without running the handler', async () => {
    const { def, calls } = postRoute(
      () => new RouteReply({ id: 'p', updatedAt: '2026-02-02T00:00:00.000Z' }, { status: 202 }),
      { mutates: false },
    );
    api = await buildTestApi({ routes: [def] });
    const headers = { 'idempotency-key': 'k1' };
    const first = await api.call('admin', 'POST', '/me/password', { headers, body: { a: 1 } });
    expect(first.status).toBe(202);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(JSON.parse(String(await api.redis.get('idem:user-admin:k1')))).toMatchObject({
      status: 202,
      body: '{"id":"p","updatedAt":"2026-02-02T00:00:00.000Z"}',
      headers: { etag: '"2026-02-02T00:00:00.000Z"' },
    });
    const second = await api.call('admin', 'POST', '/me/password', { headers, body: { a: 1 } });
    expect(calls()).toBe(1);
    expect(second.status).toBe(202);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers.etag).toBe('"2026-02-02T00:00:00.000Z"');
    expect(second.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(second.raw).toBe(first.raw);
  });

  it('17.1 stores no ETag header when the body has no updatedAt', async () => {
    const { def } = postRoute(() => ({ id: 'p' }), { mutates: false });
    api = await buildTestApi({ routes: [def] });
    await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k2' },
      body: { a: 1 },
    });
    expect(JSON.parse(String(await api.redis.get('idem:user-admin:k2'))).headers).toEqual({});
  });

  it('17.1 does not save raw replies or 204 answers', async () => {
    const raw = postRoute(() => new RouteReply('x', { raw: true }), { mutates: false });
    api = await buildTestApi({ routes: [raw.def] });
    const first = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k3' },
      body: { a: 1 },
    });
    expect(first.status).toBe(200);
    expect(await api.redis.get('idem:user-admin:k3')).toBeNull();
    await api.close();
    const none = postRoute(() => ({ id: 'p' }), { mutates: false, status: 204 });
    api = await buildTestApi({ routes: [none.def] });
    const second = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k4' },
      body: { a: 1 },
    });
    expect(second.status).toBe(204);
    expect(await api.redis.get('idem:user-admin:k4')).toBeNull();
  });

  it('17.1 ignores the Idempotency-Key on a GET', async () => {
    const { def, calls } = readRoute(() => ({ id: 'a' }));
    api = await buildTestApi({ routes: [def] });
    const headers = { 'idempotency-key': 'k5' };
    await api.call('admin', 'GET', '/me', { headers });
    const again = await api.call('admin', 'GET', '/me', { headers });
    expect(calls()).toBe(2);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect(await api.redis.get('idem:user-admin:k5')).toBeNull();
  });

  it('17.1 does not save when the handler fails', async () => {
    const { def } = postRoute(
      () => {
        throw new Error('boom');
      },
      { mutates: false },
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k6' },
      body: { a: 1 },
    });
    expect(res.status).toBe(500);
    expect(await api.redis.get('idem:user-admin:k6')).toBeNull();
  });
});

describe('17.1 route runner: the mutation transaction', () => {
  it('17.1 hands the handler the actor facts, flushes hooks after commit and keeps the audit', async () => {
    const { def } = postRoute(
      async (ctx: {
        tx: {
          audit(e: { action: string; targetType: string }): Promise<void>;
          configChanged(t: string): void;
          emit(e: unknown): void;
          afterCommit(h: () => void): void;
        };
      }) => {
        await ctx.tx.audit({ action: 'x.do', targetType: 'x' });
        await ctx.tx.audit({ action: 'x.again', targetType: 'x' });
        ctx.tx.configChanged('topic-a');
        ctx.tx.emit({ id: 'e1', type: 'notification', audience: { org: true }, data: 1 });
        ctx.tx.afterCommit(() => {
          order.push('hook');
        });
        order.push('handler-done');
        return { id: 'm' };
      },
      { mutates: true },
    );
    const order: string[] = [];
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', {
      headers: { 'user-agent': 'agent/1' },
      body: { a: 1 },
    });
    expect(res.status).toBe(201);
    expect(order).toEqual(['handler-done', 'hook']);
    expect(api.uow.audits).toHaveLength(2);
    expect(api.uow.audits[0]).toMatchObject({
      action: 'x.do',
      actorType: 'user',
      actorId: 'user-admin',
      userAgent: 'agent/1',
    });
    expect(typeof api.uow.audits[0]?.ip).toBe('string');
    expect(typeof api.uow.audits[0]?.requestId).toBe('string');
    expect(api.publisher.messages).toEqual([
      { channel: 'bastion:config', message: '{"topic":"topic-a"}' },
    ]);
    expect(api.events.published).toHaveLength(1);
  });

  it('17.1 records the user-agent header as is, an empty one too', async () => {
    const { def } = postRoute(
      async (ctx: { tx: { audit(e: { action: string; targetType: string }): Promise<void> } }) => {
        await ctx.tx.audit({ action: 'x.do', targetType: 'x' });
        return { id: 'm' };
      },
      { mutates: true },
    );
    api = await buildTestApi({ routes: [def] });
    await api.call('admin', 'POST', '/me/password', {
      headers: { 'user-agent': '' },
      body: { a: 1 },
    });
    expect(api.uow.audits[0]?.userAgent).toBe('');
  });

  it('17.1 the audit-required error rolls back store writes, publishes nothing and saves no key', async () => {
    const { def } = postRoute(
      async (ctx: {
        tx: {
          store: { insert(t: string, r: Record<string, unknown>): Promise<unknown> };
          configChanged(t: string): void;
        };
      }) => {
        await ctx.tx.store.insert('users', { email: 'ghost@example.com' });
        ctx.tx.configChanged('ghost');
        return { id: 'm' };
      },
      { mutates: true },
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k7' },
      body: { a: 1 },
    });
    expect(res.status).toBe(500);
    expect(asRecord(res.body).detail).not.toContain('audit');
    expect(await api.store.find('users', { email: 'ghost@example.com' })).toHaveLength(0);
    expect(api.publisher.messages).toHaveLength(0);
    expect(await api.redis.get('idem:user-admin:k7')).toBeNull();
  });

  it('17.1 a mutation commits even when its reply fails the response schema (no key saved)', async () => {
    const { def } = postRoute(
      async (ctx: {
        tx: {
          audit(e: { action: string; targetType: string }): Promise<void>;
          store: { insert(t: string, r: Record<string, unknown>): Promise<unknown> };
        };
      }) => {
        await ctx.tx.store.insert('users', { email: 'kept@example.com' });
        await ctx.tx.audit({ action: 'x.do', targetType: 'x' });
        return { bad: true };
      },
      { mutates: true },
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'k8' },
      body: { a: 1 },
    });
    expect(res.status).toBe(500);
    expect(await api.store.find('users', { email: 'kept@example.com' })).toHaveLength(1);
    expect(api.uow.audits).toHaveLength(1);
    expect(await api.redis.get('idem:user-admin:k8')).toBeNull();
  });

  it('17.1 a read-only POST gets no transaction and no audit', async () => {
    const { def } = postRoute(
      (ctx: { tx?: unknown }) => ({ id: ctx.tx === undefined ? 'no-tx' : 'tx' }),
      {
        mutates: false,
      },
    );
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', { body: { a: 1 } });
    expect(asRecord(res.body).id).toBe('no-tx');
    expect(api.uow.audits).toHaveLength(0);
  });

  it('17.1 a replayed key skips the transaction entirely', async () => {
    const { def, calls } = postRoute(
      async (ctx: { tx: { audit(e: { action: string; targetType: string }): Promise<void> } }) => {
        await ctx.tx.audit({ action: 'x.do', targetType: 'x' });
        return { id: 'm' };
      },
      { mutates: true },
    );
    api = await buildTestApi({ routes: [def] });
    const headers = { 'idempotency-key': 'k9' };
    await api.call('admin', 'POST', '/me/password', { headers, body: { a: 1 } });
    await api.call('admin', 'POST', '/me/password', { headers, body: { a: 1 } });
    expect(calls()).toBe(1);
    expect(api.uow.audits).toHaveLength(1);
  });
});

describe('17.1 route runner: step order', () => {
  it('17.1 checks If-Match before running the handler and the transaction', async () => {
    let ran = false;
    const def = defineMutation({
      method: 'PATCH',
      url: '/me',
      tag: 't',
      summary: 'patch',
      schema: { response: itemOut },
      authz: authz.self(),
      version: async () => '2026-03-03T00:00:00.000Z',
      handler: async () => {
        ran = true;
        return { id: 'a' };
      },
    });
    api = await buildTestApi({ routes: [def] });
    const missing = await api.call('admin', 'PATCH', '/me');
    expect(missing.status).toBe(428);
    const stale = await api.call('admin', 'PATCH', '/me', { headers: { 'if-match': '"old"' } });
    expect(stale.status).toBe(412);
    expect(ran).toBe(false);
    const fresh = await api.call('admin', 'PATCH', '/me', {
      headers: { 'if-match': '"2026-03-03T00:00:00.000Z"' },
    });
    expect(ran).toBe(true);
    expect(fresh.status).toBe(500);
  });

  it('17.1 a version of null needs no If-Match and the handler runs (a 404 is the handler job)', async () => {
    let ran = false;
    const def = defineMutation({
      method: 'PATCH',
      url: '/me',
      tag: 't',
      summary: 'patch',
      schema: { response: itemOut },
      authz: authz.self(),
      version: async () => null,
      handler: async () => {
        ran = true;
        return { id: 'a' };
      },
    });
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'PATCH', '/me', {});
    expect(ran).toBe(true);
    expect(res.status).toBe(500);
  });

  it('17.1 validates the Idempotency-Key before looking it up and before the handler', async () => {
    const { def, calls } = postRoute(() => ({ id: 'p' }), { mutates: false });
    api = await buildTestApi({ routes: [def] });
    const res = await api.call('admin', 'POST', '/me/password', {
      headers: { 'idempotency-key': 'x'.repeat(300) },
      body: { a: 1 },
    });
    expect(res.status).toBe(400);
    expect(calls()).toBe(0);
  });
});

import http from 'node:http';
import {
  ERROR_CODES,
  RateLimitedError,
  SandboxStartFailedError,
  sha256Hex,
  UpstreamAuthRequiredError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import { INTERNAL_SIG_HEADER, INTERNAL_TS_HEADER, signInternalRequest } from '@bastion-mcp/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UpstreamRpcError } from '../src/errors';
import { ForwardConnectError, InternalRpcClient } from '../src/rpc/client';
import {
  fromErrorEvent,
  matchRoute,
  opPath,
  RPC_PREFIX,
  resumePath,
  sessionResponsePath,
  subscriptionsPath,
  toErrorEvent,
} from '../src/rpc/protocol';
import {
  createInternalRpcServer,
  type InternalRpcHandlers,
  type RpcRequest,
} from '../src/rpc/server';
import type { UpstreamNotification, UpstreamOutcome, WireContext } from '../src/types';

const SECRET = 'a'.repeat(40);
const wireCtx: WireContext = {
  principal: { userId: 'u1', clientName: 'cursor' },
  installationId: 'inst-1',
  era: 'modern',
  clientCapabilities: {},
  trace: {},
};

const sign = (method: string, path: string, body: string, ts = Date.now(), secret = SECRET) => ({
  [INTERNAL_TS_HEADER]: String(ts),
  [INTERNAL_SIG_HEADER]: signInternalRequest({ ts, method, path, body, secret }),
});

const collect = async (body: AsyncIterable<string> | string): Promise<string> => {
  if (typeof body === 'string') return body;
  let out = '';
  for await (const chunk of body) out += chunk;
  return out;
};

describe('21.2 internal RPC protocol', () => {
  it('21.2 the routes live under /internal/v1', () => {
    expect(RPC_PREFIX).toBe('/internal/v1');
    expect(opPath('i 1')).toBe('/internal/v1/instances/i%201/op');
    expect(matchRoute('POST', opPath('abc'))).toEqual({ kind: 'op', instanceId: 'abc' });
    expect(matchRoute('POST', resumePath('c1'))).toEqual({ kind: 'resume', continuationId: 'c1' });
    expect(matchRoute('POST', subscriptionsPath('i'))).toEqual({
      kind: 'subscriptions',
      instanceId: 'i',
    });
    expect(matchRoute('POST', sessionResponsePath('s'))).toEqual({
      kind: 'sessionResponse',
      sessionId: 's',
    });
    expect(matchRoute('GET', opPath('abc'))).toBeNull();
    expect(matchRoute('POST', '/internal/v2/instances/a/op')).toBeNull();
    expect(matchRoute('POST', '/internal/v1/instances/a/b/op')).toBeNull();
  });

  it('6.9 typed errors keep their codes across the hop', () => {
    const cases = [
      new UpstreamUnavailableError('gone', { installation: 'x' }),
      new UpstreamAuthRequiredError('auth', {
        installation: 'x',
        connectUrl: 'https://b/connect/1',
      }),
      new SandboxStartFailedError('boom', { installation: 'x', phase: 'installing' }),
      new UpstreamTimeoutError('slow', { installation: 'x', timeoutMs: 5 }),
      new RateLimitedError('cap', { retryAfterMs: 5000, limit: 'sandboxes' }),
    ];
    for (const error of cases) {
      const event = toErrorEvent(error);
      const back = fromErrorEvent(event);
      expect(back.constructor).toBe(error.constructor);
      expect(back.mcpCode).toBe(error.mcpCode);
      expect(back.data).toEqual(error.data);
    }
    expect(toErrorEvent(cases[0] as UpstreamUnavailableError).code).toBe(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
    );
  });

  it('6.9 an upstream JSON-RPC error and a plain error survive the hop', () => {
    const rpc = new UpstreamRpcError(-32602, 'bad args', { field: 'x' });
    const back = fromErrorEvent(toErrorEvent(rpc));
    expect(back).toBeInstanceOf(UpstreamRpcError);
    expect(back.mcpCode).toBe(-32602);
    expect(toErrorEvent(new Error('plain')).code).toBe(-32603);
    expect(toErrorEvent('weird').message).toBe('weird');
  });
});

describe('21.2 internal RPC server (signed requests)', () => {
  const outcome: UpstreamOutcome = { kind: 'complete', result: { ok: true } };
  const calls: string[] = [];
  const handlers: InternalRpcHandlers = {
    op: async (id, body, emit) => {
      calls.push(`op:${id}:${body.method}`);
      emit({ type: 'notification', method: 'notifications/progress', params: { progress: 1 } });
      if (body.method === 'boom') throw new UpstreamUnavailableError('down', { installation: 'x' });
      return outcome;
    },
    resume: async (id) => {
      calls.push(`resume:${id}`);
      return outcome;
    },
    subscriptions: async (id, body) => {
      calls.push(`sub:${id}:${body.action}`);
    },
    sessionResponse: async (id, message) => {
      calls.push(`resp:${id}:${JSON.stringify(message)}`);
    },
  };
  const server = createInternalRpcServer({
    secret: SECRET,
    previousSecret: 'b'.repeat(40),
    handlers,
  });
  const body = JSON.stringify({ method: 'tools/call', params: { name: 't' }, ctx: wireCtx });
  const request = (
    over: Partial<RpcRequest> & { headers?: RpcRequest['headers'] } = {},
  ): RpcRequest => ({
    method: 'POST',
    path: opPath('inst-a'),
    headers: sign('POST', opPath('inst-a'), body),
    body,
    ...over,
  });

  it('21.2 rejects a request without a signature', async () => {
    const res = await server.handle(request({ headers: {} }));
    expect(res.status).toBe(401);
  });

  it('21.2 rejects a signature over a different body, path or method', async () => {
    const other = sign('POST', opPath('inst-a'), '{"x":1}');
    expect((await server.handle(request({ headers: other }))).status).toBe(401);
    const wrongPath = sign('POST', opPath('inst-b'), body);
    expect((await server.handle(request({ headers: wrongPath }))).status).toBe(401);
    const wrongSecret = sign('POST', opPath('inst-a'), body, Date.now(), 'c'.repeat(40));
    expect((await server.handle(request({ headers: wrongSecret }))).status).toBe(401);
  });

  it('21.2 rejects timestamps more than 30 s off in either direction', async () => {
    for (const skew of [-31_000, 31_000]) {
      const res = await server.handle(
        request({ headers: sign('POST', opPath('inst-a'), body, Date.now() + skew) }),
      );
      expect(res.status).toBe(401);
    }
    const ok = await server.handle(
      request({ headers: sign('POST', opPath('inst-a'), body, Date.now() - 29_000) }),
    );
    expect(ok.status).toBe(200);
  });

  it('21.2 accepts BASTION_INTERNAL_SECRET_PREVIOUS during rotation', async () => {
    const res = await server.handle(
      request({ headers: sign('POST', opPath('inst-a'), body, Date.now(), 'b'.repeat(40)) }),
    );
    expect(res.status).toBe(200);
  });

  it('21.2 streams NDJSON: notifications first, then exactly one outcome', async () => {
    const res = await server.handle(request());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    const lines = (await collect(res.body))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['notification', 'outcome']);
    expect(lines[1].outcome).toEqual(outcome);
  });

  it('21.2 a failing operation ends with one error event', async () => {
    const failing = JSON.stringify({ method: 'boom', params: {}, ctx: wireCtx });
    const res = await server.handle({
      method: 'POST',
      path: opPath('inst-a'),
      headers: sign('POST', opPath('inst-a'), failing),
      body: failing,
    });
    const lines = (await collect(res.body))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ type: 'error', code: -32014 });
  });

  it('21.2 serves continuation resume, subscription and session response routes', async () => {
    const resumeBody = JSON.stringify({
      inputResponses: { b0: { action: 'accept' } },
      ctx: wireCtx,
    });
    const resume = await server.handle({
      method: 'POST',
      path: resumePath('c-9'),
      headers: sign('POST', resumePath('c-9'), resumeBody),
      body: resumeBody,
    });
    expect((await collect(resume.body)).includes('"outcome"')).toBe(true);
    const subBody = JSON.stringify({
      action: 'add',
      kind: 'resource',
      uri: 'u://x',
      principalId: 'u1',
      ctx: wireCtx,
    });
    const sub = await server.handle({
      method: 'POST',
      path: subscriptionsPath('inst-a'),
      headers: sign('POST', subscriptionsPath('inst-a'), subBody),
      body: subBody,
    });
    expect(sub.status).toBe(200);
    const respBody = JSON.stringify({ message: { jsonrpc: '2.0', id: 1, result: {} } });
    const resp = await server.handle({
      method: 'POST',
      path: sessionResponsePath('sess-1'),
      headers: sign('POST', sessionResponsePath('sess-1'), respBody),
      body: respBody,
    });
    expect(resp.status).toBe(202);
    expect(calls).toContain('resume:c-9');
    expect(calls).toContain('sub:inst-a:add');
    expect(calls.some((c) => c.startsWith('resp:sess-1'))).toBe(true);
  });

  it('21.2 unknown routes are 404 and malformed bodies 400, after authentication', async () => {
    expect(
      (await server.handle({ method: 'POST', path: '/internal/v1/nope', headers: {}, body: '' }))
        .status,
    ).toBe(404);
    const bad = '{not json';
    const badJson = await server.handle({
      method: 'POST',
      path: opPath('i'),
      headers: sign('POST', opPath('i'), bad),
      body: bad,
    });
    expect(badJson.status).toBe(400);
    const wrong = JSON.stringify({ method: 'x' });
    const badBody = await server.handle({
      method: 'POST',
      path: opPath('i'),
      headers: sign('POST', opPath('i'), wrong),
      body: wrong,
    });
    expect(badBody.status).toBe(400);
    void sha256Hex;
  });
});

describe('21.2 internal RPC over real HTTP between two workers', () => {
  let listener: { port: number; close: () => Promise<void> };
  const seen: { signal?: AbortSignal; ctx?: WireContext; headers?: http.IncomingHttpHeaders }[] =
    [];
  const handlers: InternalRpcHandlers = {
    op: async (_id, body, emit, signal) => {
      seen.push({ signal, ctx: body.ctx });
      if (body.method === 'slow') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return { kind: 'complete', result: 'aborted' };
      }
      if (body.method === 'hang') await new Promise(() => undefined);
      emit({ type: 'notification', method: 'notifications/progress', params: { progress: 5 } });
      emit({ type: 'notification', method: 'notifications/message', params: { data: 'x' } });
      if (body.method === 'input') {
        return {
          kind: 'input_required',
          inputRequests: { b0: { method: 'elicitation/create', params: {} } },
          requestState: 'bst1.k.x',
        };
      }
      return { kind: 'complete', result: { echoed: body.params } };
    },
    resume: async () => ({ kind: 'complete', result: 'resumed' }),
    subscriptions: async (_id, body) => {
      if (body.uri === 'bad') throw new UpstreamUnavailableError('no owner', { installation: 'i' });
    },
  };
  const server = createInternalRpcServer({ secret: SECRET, handlers });
  const client = new InternalRpcClient({ secret: SECRET });

  beforeAll(async () => {
    listener = await server.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await client.close();
    await listener.close();
  });

  const address = () => `127.0.0.1:${listener.port}`;

  it('21.2 forwards an operation and relays notifications then the outcome', async () => {
    const notes: UpstreamNotification[] = [];
    const out = await client.forwardOp(
      address(),
      'inst-9',
      { method: 'tools/call', params: { name: 'x' }, ctx: wireCtx },
      { onNotification: (n) => notes.push(n) },
    );
    expect(out).toEqual({ kind: 'complete', result: { echoed: { name: 'x' } } });
    expect(notes.map((n) => n.method)).toEqual(['notifications/progress', 'notifications/message']);
    expect(seen.at(-1)?.ctx?.principal.userId).toBe('u1');
  });

  it('6.5 forwards an input_required outcome intact', async () => {
    const out = await client.forwardOp(address(), 'i', {
      method: 'input',
      params: {},
      ctx: wireCtx,
    });
    expect(out.kind).toBe('input_required');
    if (out.kind === 'input_required') {
      expect(out.requestState).toBe('bst1.k.x');
      expect(Object.keys(out.inputRequests ?? {})).toEqual(['b0']);
    }
  });

  it('21.2 resume goes to POST /internal/v1/continuations/{id}/resume', async () => {
    const out = await client.forwardResume(address(), 'c1', { inputResponses: {}, ctx: wireCtx });
    expect(out).toEqual({ kind: 'complete', result: 'resumed' });
  });

  it('6.9 an owner error arrives as the typed error', async () => {
    const failing = createInternalRpcServer({
      secret: SECRET,
      handlers: {
        ...handlers,
        op: async () => {
          throw new UpstreamTimeoutError('t', { installation: 'inst-1', timeoutMs: 60_000 });
        },
      },
    });
    const l = await failing.listen(0, '127.0.0.1');
    try {
      await expect(
        client.forwardOp(`127.0.0.1:${l.port}`, 'i', {
          method: 'tools/call',
          params: {},
          ctx: wireCtx,
        }),
      ).rejects.toBeInstanceOf(UpstreamTimeoutError);
    } finally {
      await l.close();
    }
  });

  it('21.2 aborting the caller closes the stream, which aborts the owner operation', async () => {
    const controller = new AbortController();
    const before = seen.length;
    const pending = client.forwardOp(
      address(),
      'i',
      { method: 'slow', params: {}, ctx: wireCtx },
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 150));
    controller.abort(new Error('client left'));
    await expect(pending).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen[before]?.signal?.aborted).toBe(true);
  });

  it('21.2 a refused connection is a ForwardConnectError so the caller can re-read the lease and retry', async () => {
    await expect(
      client.forwardOp('127.0.0.1:1', 'i', { method: 'tools/call', params: {}, ctx: wireCtx }),
    ).rejects.toBeInstanceOf(ForwardConnectError);
  });

  it('21.3 an owner that dies mid-call fails the request with -32014', async () => {
    const dying = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({ type: 'notification', method: 'notifications/progress', params: {} })}\n`,
      );
      setTimeout(() => req.socket.destroy(), 50);
    });
    await new Promise<void>((resolve) => dying.listen(0, '127.0.0.1', resolve));
    const port = (dying.address() as { port: number }).port;
    try {
      const error = await client
        .forwardOp(`127.0.0.1:${port}`, 'i', {
          method: 'tools/call',
          params: {},
          ctx: { ...wireCtx, deadlineAt: Date.now() + 5000 },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamUnavailableError);
    } finally {
      dying.closeAllConnections();
      dying.close();
    }
  });

  it('21.2 rejects an unsigned HTTP request with 401', async () => {
    const res = await fetch(`http://${address()}${opPath('x')}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('21.2 forwards subscription changes and surfaces owner errors', async () => {
    await expect(
      client.forwardSubscription(address(), 'i', {
        action: 'add',
        kind: 'resource',
        uri: 'test://x',
        principalId: 'u1',
        ctx: wireCtx,
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.forwardSubscription(address(), 'i', {
        action: 'add',
        kind: 'resource',
        uri: 'bad',
        principalId: 'u1',
        ctx: wireCtx,
      }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('21.2 session responses: 404 from a worker that does not handle them fails the forward', async () => {
    await expect(
      client.forwardSessionResponse(address(), 'sess', { jsonrpc: '2.0', id: 1, result: {} }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('21.2 a non-200 answer from the owner is -32014', async () => {
    const res = createInternalRpcServer({ secret: 'z'.repeat(40), handlers });
    const l = await res.listen(0, '127.0.0.1');
    try {
      await expect(
        client.forwardOp(`127.0.0.1:${l.port}`, 'i', {
          method: 'tools/call',
          params: {},
          ctx: wireCtx,
        }),
      ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    } finally {
      await l.close();
    }
  });
});

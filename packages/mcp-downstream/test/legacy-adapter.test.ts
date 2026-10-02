import { BastionError, REDIS_CHANNELS, redisKeys } from '@bastion-mcp/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpRunner } from '../src/adapters/contracts';
import { OTHER_USER_ID, USER_ID } from './helpers/fixtures';
import {
  defaultRun,
  type Harness,
  initialize,
  post,
  rpc,
  sseMessages,
  startHarness,
} from './legacy-harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sid = (id: string) => ({ 'mcp-session-id': id });

describe('6.2 legacy sessions', () => {
  it('6.2 initialize answers JSON, creates sess:{id} with a 30 minute sliding TTL and returns Mcp-Session-Id', async () => {
    h = await startHarness();
    const res = await post(
      h,
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { roots: {} },
        clientInfo: { name: 'c', version: '1' },
      }),
    );
    expect(res.headers.get('content-type')).toContain('application/json');
    const id = res.headers.get('mcp-session-id') ?? '';
    expect(Buffer.from(id, 'base64url').length).toBe(32);
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    const hash = await h.redis.hgetall(redisKeys.session(id));
    expect(hash).toMatchObject({
      principalId: USER_ID,
      tokenHash: 'hash-1',
      protocolVersion: '2025-06-18',
      endpointId: 'default',
    });
    expect(JSON.parse(hash.clientCapabilities ?? '')).toEqual({ roots: {} });
    expect(h.redis.ttlSeconds(redisKeys.session(id))).toBe(1800);
    expect(await h.redis.zcard(redisKeys.sessionList(USER_ID))).toBe(1);
    h.redis.now += 600_000;
    await post(h, rpc(2, 'ping'), sid(id));
    expect(h.redis.ttlSeconds(redisKeys.session(id))).toBe(1800);
  });

  it('6.2 a session id used with another principal gets 404', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const res = await post(h, rpc(2, 'ping'), { ...sid(id), 'x-test-user': 'other' });
    expect(res.status).toBe(404);
    expect((await post(h, rpc(2, 'ping'), sid(id))).status).toBe(200);
    expect(OTHER_USER_ID).not.toBe(USER_ID);
  });

  it('6.2 a session of another endpoint is 404, a missing id is 400, an unknown id is 404', async () => {
    h = await startHarness();
    const id = await initialize(h);
    await h.redis.hset(redisKeys.session(id), { endpointId: 'i:other' });
    expect((await post(h, rpc(2, 'ping'), sid(id))).status).toBe(404);
    expect((await post(h, rpc(2, 'ping'))).status).toBe(400);
    expect((await post(h, rpc(2, 'ping'), sid('nope'))).status).toBe(404);
  });

  it('6.1 a request without MCP-Protocol-Version uses the session version; an unsupported one is 400', async () => {
    let seen = '';
    const run: OpRunner = async (m, p, ctx) => {
      seen = ctx.protocolVersion;
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    await post(h, rpc(2, 'tools/list'), sid(id));
    expect(seen).toBe('2025-11-25');
    const bad = await post(h, rpc(3, 'tools/list'), {
      ...sid(id),
      'mcp-protocol-version': '1999-01-01',
    });
    expect(bad.status).toBe(400);
    const modern = await post(h, rpc(3, 'tools/list'), {
      ...sid(id),
      'mcp-protocol-version': '2026-07-28',
    });
    expect(modern.status).toBe(400);
    await post(h, rpc(4, 'tools/list'), { ...sid(id), 'mcp-protocol-version': '2025-06-18' });
    expect(seen).toBe('2025-06-18');
  });

  it('6.2 the operation context is legacy, carries session capabilities and the session id', async () => {
    let ctxSeen:
      | { era: string; caps: unknown; sessionId?: string | undefined; reqId?: unknown }
      | undefined;
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/list')
        ctxSeen = {
          era: ctx.era,
          caps: ctx.clientCapabilities,
          sessionId: ctx.sessionId,
          reqId: ctx.requestId,
        };
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    await post(h, rpc(7, 'tools/list'), sid(id));
    expect(ctxSeen).toEqual({
      era: 'legacy',
      caps: { elicitation: { form: {} } },
      sessionId: id,
      reqId: 7,
    });
  });

  it('6.2 per-principal cap evicts the oldest idle session', async () => {
    h = await startHarness({ deps: { maxSessionsPerPrincipal: 2 } });
    const a = await initialize(h);
    h.redis.now += 1000;
    const b = await initialize(h);
    h.redis.now += 1000;
    await post(h, rpc(2, 'ping'), sid(a));
    h.redis.now += 1000;
    const c = await initialize(h);
    expect(await h.redis.hgetall(redisKeys.session(b))).toEqual({});
    expect((await h.redis.hgetall(redisKeys.session(a))).principalId).toBe(USER_ID);
    expect((await h.redis.hgetall(redisKeys.session(c))).principalId).toBe(USER_ID);
    expect(h.redis.published.some((p) => p.channel === REDIS_CHANNELS.session(b))).toBe(true);
  });

  it('6.2 DELETE ends the session; the id is 404 afterwards; another principal gets 404', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const other = await fetch(h.url, {
      method: 'DELETE',
      headers: { ...sid(id), 'x-test-user': 'other' },
    });
    expect(other.status).toBe(404);
    const del = await fetch(h.url, { method: 'DELETE', headers: sid(id) });
    expect(del.status).toBe(200);
    expect(await h.redis.zcard(redisKeys.sessionList(USER_ID))).toBe(0);
    expect((await post(h, rpc(2, 'ping'), sid(id))).status).toBe(404);
  });
});

describe('6.2 legacy POST shapes', () => {
  it('6.2 lists answer application/json and tools/call answers an SSE stream with progress then the response, without event ids', async () => {
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call') {
        ctx.emit({ method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } });
        return { kind: 'complete', result: { content: [{ type: 'text', text: 'hi' }] } };
      }
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    const list = await post(h, rpc(2, 'tools/list'), sid(id));
    expect(list.headers.get('content-type')).toContain('application/json');
    const call = await post(h, rpc(3, 'tools/call', { name: 'x' }), {
      ...sid(id),
      'last-event-id': '5',
    });
    expect(call.headers.get('content-type')).toContain('text/event-stream');
    const text = await call.text();
    expect(text).not.toContain('\nid:');
    const msgs = sseMessages(text);
    expect(msgs[0]).toMatchObject({ method: 'notifications/progress' });
    expect(msgs[1]).toMatchObject({ id: 3, result: { content: [{ text: 'hi' }] } });
  });

  it('6.2 tools/call answers JSON when the client does not accept SSE', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const res = await post(h, rpc(3, 'tools/call', { name: 'x' }), {
      ...sid(id),
      accept: 'application/json',
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { id: number }).id).toBe(3);
  });

  it('6.9 operation errors are JSON-RPC errors with HTTP 200', async () => {
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call')
        throw new BastionError('X', 'nope', { httpStatus: 400, mcpCode: -32602 });
      if (m === 'prompts/get') throw new Error('secret internals');
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    const a = await post(h, rpc(2, 'tools/call'), { ...sid(id), accept: 'application/json' });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ id: 2, error: { code: -32602, message: 'nope' } });
    const b = await post(h, rpc(3, 'prompts/get'), sid(id));
    const msgs = sseMessages(await b.text());
    expect(msgs[0]).toMatchObject({ id: 3, error: { code: -32603, message: 'Internal error' } });
  });

  it('6.2 notifications and client responses are acknowledged with 202', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const n = await post(h, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid(id));
    expect(n.status).toBe(202);
    const r = await post(h, { jsonrpc: '2.0', id: 'unknown', result: {} }, sid(id));
    expect(r.status).toBe(202);
  });

  it('6.9 invalid JSON-RPC, batches and other HTTP methods are rejected', async () => {
    h = await startHarness();
    const bad = await post(h, { hello: 'world' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32600 } });
    expect((await post(h, [rpc(1, 'ping')])).status).toBe(400);
    const put = await fetch(h.url, { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST, DELETE');
  });

  it('6.3 logging/setLevel stores the level; resources/subscribe and unsubscribe maintain the session subscriptions', async () => {
    h = await startHarness();
    const id = await initialize(h);
    await post(h, rpc(2, 'logging/setLevel', { level: 'warning' }), sid(id));
    expect((await h.redis.hgetall(redisKeys.session(id))).logLevel).toBe('warning');
    await post(h, rpc(3, 'resources/subscribe', { uri: 'a://x' }), sid(id));
    await post(h, rpc(4, 'resources/subscribe', { uri: 'a://y' }), sid(id));
    await post(h, rpc(5, 'resources/unsubscribe', { uri: 'a://x' }), sid(id));
    expect(JSON.parse((await h.redis.hgetall(redisKeys.session(id))).subs ?? '')).toEqual([
      'a://y',
    ]);
  });
});

describe('6.6 cancellation', () => {
  it('6.6 notifications/cancelled aborts the in-flight request, also when it arrives on another worker', async () => {
    let aborted = false;
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call') {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }),
        );
        return { kind: 'complete', result: { content: [] } };
      }
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    const pending = post(h, rpc(9, 'tools/call', { name: 'slow' }), sid(id));
    await sleep(60);
    // Simulates a cancel handled by another worker: only the Redis channel carries it.
    await h.redis.publish(
      REDIS_CHANNELS.session(id),
      JSON.stringify({ type: 'cancel', requestId: 9 }),
    );
    await pending.then((r) => r.text());
    expect(aborted).toBe(true);
  });

  it('6.6 notifications/cancelled over HTTP answers 202 and aborts', async () => {
    let aborted = false;
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call') {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }),
        );
        return { kind: 'complete', result: {} };
      }
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    const pending = post(h, rpc(4, 'tools/call', { name: 'slow' }), sid(id));
    await sleep(60);
    const c = await post(
      h,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } },
      sid(id),
    );
    expect(c.status).toBe(202);
    await pending.then((r) => r.text());
    expect(aborted).toBe(true);
  });

  it('6.6 closing the response stream aborts the operation signal', async () => {
    let aborted = false;
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call') {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }),
        );
        return { kind: 'complete', result: {} };
      }
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run });
    const id = await initialize(h);
    const ac = new AbortController();
    const p = fetch(h.url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...sid(id) },
      body: JSON.stringify(rpc(5, 'tools/call', {})),
    }).catch(() => undefined);
    await sleep(60);
    ac.abort();
    await p;
    await sleep(60);
    expect(aborted).toBe(true);
  });
});

describe('6.5 server-to-client requests', () => {
  const elicitRun: OpRunner = async (m, p, ctx) => {
    if (m === 'tools/call') {
      const answers = p.inputResponses as { q?: { content?: { n?: string } } } | undefined;
      if (!answers) {
        return {
          kind: 'input_required',
          inputRequests: { q: { method: 'elicitation/create', params: { message: 'name?' } } },
          requestState: 'bst1.x',
          installationId: 'inst-a',
        };
      }
      return {
        kind: 'complete',
        result: { content: [{ type: 'text', text: `hello ${answers.q?.content?.n}` }] },
      };
    }
    return defaultRun(m, p, ctx);
  };

  it('6.5 fans inputRequests out on the SSE stream with remapped ids, writes pend keys and retries with the answers', async () => {
    h = await startHarness({ run: elicitRun });
    const id = await initialize(h);
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...sid(id) },
      body: JSON.stringify(rpc(3, 'tools/call', { name: 't' })),
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let buf = '';
    while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
    const request = sseMessages(buf)[0];
    expect(request).toMatchObject({ method: 'elicitation/create', params: { message: 'name?' } });
    const rid = String(request?.id);
    expect(rid).toMatch(/^bstn-/);
    expect(await h.redis.get(redisKeys.pendingResponse(id, rid))).toBe('w1');
    const ack = await post(
      h,
      { jsonrpc: '2.0', id: rid, result: { action: 'accept', content: { n: 'Ada' } } },
      sid(id),
    );
    expect(ack.status).toBe(202);
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value);
      if (done) break;
    }
    const msgs = sseMessages(buf);
    expect(msgs.at(-1)).toMatchObject({ id: 3, result: { content: [{ text: 'hello Ada' }] } });
    expect(await h.redis.get(redisKeys.pendingResponse(id, rid))).toBeNull();
  });

  it('6.5 a client JSON-RPC error response becomes an error entry; a timeout cancels the elicitation', async () => {
    const seen: unknown[] = [];
    const run: OpRunner = async (m, p, ctx) => {
      if (m === 'tools/call') {
        if (!p.inputResponses)
          return {
            kind: 'input_required',
            inputRequests: { k: { method: 'sampling/createMessage', params: {} } },
            requestState: 's',
          };
        seen.push(p.inputResponses);
        return { kind: 'complete', result: {} };
      }
      return defaultRun(m, p, ctx);
    };
    h = await startHarness({ run, deps: { pendingResponseTimeoutMs: 80 } });
    const id = await initialize(h);
    // sampling is not declared by the initialize caps of the harness -> answered locally with -32601
    const res = await post(h, rpc(3, 'tools/call', {}), sid(id));
    await res.text();
    expect(seen[0]).toEqual({
      k: { error: { code: -32601, message: 'client does not support sampling' } },
    });
    // declare sampling and let it time out
    await h.redis.hset(redisKeys.session(id), {
      clientCapabilities: JSON.stringify({ sampling: {} }),
    });
    const res2 = await post(h, rpc(4, 'tools/call', {}), sid(id));
    const msgs = sseMessages(await res2.text());
    expect(msgs[0]).toMatchObject({ method: 'sampling/createMessage' });
    expect(seen[1]).toEqual({
      k: { error: { code: -32603, message: 'the client did not answer in time' } },
    });
  });

  it('6.5 a client answer arriving on another worker is forwarded to the issuing worker over the internal RPC', async () => {
    h = await startHarness({ workerId: 'w2', peers: { w1: '10.0.0.1:7443' } });
    const id = await initialize(h);
    await h.redis.set(redisKeys.pendingResponse(id, 'bstn-1'), 'w1', 'EX', 600);
    const res = await post(
      h,
      { jsonrpc: '2.0', id: 'bstn-1', result: { action: 'accept' } },
      sid(id),
    );
    expect(res.status).toBe(202);
    expect(h.forwarded).toEqual([
      {
        address: '10.0.0.1:7443',
        sessionId: id,
        message: { jsonrpc: '2.0', id: 'bstn-1', result: { action: 'accept' } },
      },
    ]);
  });
});

describe('6.2 legacy GET stream', () => {
  const openGet = async (url: string, id: string, extra: Record<string, string> = {}) => {
    const ac = new AbortController();
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': id, ...extra },
      signal: ac.signal,
    });
    return { res, ac };
  };

  it('6.2 GET needs Accept text/event-stream (406) and a valid session', async () => {
    h = await startHarness();
    const id = await initialize(h);
    expect((await fetch(h.url, { headers: { 'mcp-session-id': id } })).status).toBe(406);
    expect((await fetch(h.url, { headers: { accept: 'text/event-stream' } })).status).toBe(400);
    expect(
      (
        await fetch(h.url, {
          headers: { accept: 'text/event-stream', 'mcp-session-id': id, 'x-test-user': 'other' },
        })
      ).status,
    ).toBe(404);
  });

  it('6.2 a second GET closes the first', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const first = await openGet(h.url, id);
    expect(first.res.status).toBe(200);
    await sleep(30);
    const second = await openGet(h.url, id);
    await first.res.text();
    expect(h.adapter.activeStreams()).toBe(1);
    second.ac.abort();
  });

  it('6.6 hub events become list_changed and resources/updated notifications; updates only for subscribed URIs; keepalive comments flow', async () => {
    h = await startHarness();
    const id = await initialize(h);
    await post(h, rpc(2, 'resources/subscribe', { uri: 'a://y' }), sid(id));
    const { res, ac } = await openGet(h.url, id);
    await sleep(30);
    expect(h.hub.targets[0]?.target).toEqual({
      principalId: USER_ID,
      teamIds: ['0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60'],
      endpointId: 'default',
    });
    const targets = {};
    h.hub.emit({ targets, kind: 'tools_list_changed' });
    h.hub.emit({ targets, kind: 'prompts_list_changed' });
    h.hub.emit({ targets, kind: 'resources_list_changed' });
    h.hub.emit({ targets, kind: 'resource_updated', uri: 'a://other' });
    h.hub.emit({ targets, kind: 'resource_updated', uri: 'a://y' });
    await sleep(120);
    const reader = res.body?.getReader();
    let text = '';
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !text.includes('keepalive')) {
      const r = await reader?.read();
      if (r?.value) text += decoder.decode(r.value);
    }
    ac.abort();
    const methods = sseMessages(text).map((m) => m.method);
    expect(methods).toEqual([
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
      'notifications/resources/updated',
    ]);
    expect(sseMessages(text).at(-1)).toMatchObject({ params: { uri: 'a://y' } });
    expect(text).toContain(': keepalive');
    await sleep(60);
    expect(h.hub.targets).toHaveLength(0);
  });

  it('6.2 a close message on the session channel ends the stream', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const { res } = await openGet(h.url, id);
    await sleep(30);
    await h.redis.publish(REDIS_CHANNELS.session(id), JSON.stringify({ type: 'close' }));
    await res.text();
    expect(h.adapter.activeStreams()).toBe(0);
  });
});

describe('21.2 graceful shutdown', () => {
  it('21.2 shutdown ends every open SSE stream', async () => {
    h = await startHarness();
    const id = await initialize(h);
    const res = await fetch(h.url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': id },
    });
    await sleep(30);
    expect(h.adapter.activeStreams()).toBe(1);
    await h.adapter.shutdown();
    await res.text();
    expect(h.adapter.activeStreams()).toBe(0);
  });
});

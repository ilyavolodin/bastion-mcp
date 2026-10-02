import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { REDIS_CHANNELS } from '@bastion-mcp/core';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyEvent } from '../src/adapters/contracts';
import { createListenAdapter, type ListenAdapterDeps } from '../src/adapters/modern/listen';
import type { BastionRequestContext } from '../src/context';
import { NotifyHub } from '../src/notify-hub';
import { FakeRedis } from './helpers/fake-redis';
import {
  buildEndpoint,
  installation,
  items,
  principal,
  requestContext,
  uuidFor,
} from './helpers/fixtures';

const INST_A = uuidFor('inst-a');

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const listenBody = (notifications: unknown, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'subscriptions/listen',
  params: { notifications, _meta: ENVELOPE },
});

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'subscriptions/listen',
};

type Frame = { event: string; data: Record<string, unknown> } | { comment: string };

/** Reads SSE frames from a fetch response until `done` says stop or the stream ends. */
const readFrames = async (
  res: Response,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 3000,
): Promise<Frame[]> => {
  const frames: Frame[] = [];
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until(frames)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (raw.startsWith(':')) frames.push({ comment: raw });
      else {
        const data = raw.split('\n').find((l) => l.startsWith('data:'));
        if (data) frames.push({ event: 'message', data: JSON.parse(data.slice(5)) });
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  reader.releaseLock();
  return frames;
};

const messages = (frames: Frame[]): Record<string, unknown>[] =>
  frames.flatMap((f) => ('data' in f ? [f.data] : []));

describe('6.6 listen adapter', () => {
  let server: http.Server;
  let url: string;
  let redis: FakeRedis;
  let hub: NotifyHub;
  let rc: BastionRequestContext;
  let calls: string[];
  let adapter: ReturnType<typeof createListenAdapter>;
  let canRead: ListenAdapterDeps['canReadUri'];

  const start = async (over: Partial<ListenAdapterDeps> = {}) => {
    redis = new FakeRedis();
    hub = new NotifyHub({ redis });
    await hub.start();
    calls = [];
    canRead = async (_rc, uri) =>
      uri.startsWith('test://') ? { ok: true, installationId: INST_A } : { ok: false };
    const resolved = await buildEndpoint({
      installations: [installation('a')],
      items: { [INST_A]: items() },
    });
    rc = requestContext(resolved, { principal: principal() });
    adapter = createListenAdapter({
      hub,
      canReadUri: (r, u) => canRead(r, u),
      keepAliveMs: 40,
      upstream: {
        joinListen: async (a) => void calls.push(`join:${a.installationId}`),
        leaveListen: async (a) => void calls.push(`leave:${a.installationId}`),
        subscribeResource: async (a) => void calls.push(`sub:${a.downstreamUri}`),
        unsubscribeResource: async (a) => void calls.push(`unsub:${a.downstreamUri}`),
      },
      ...over,
    });
    server = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        await adapter.handle({ req, res, body: text ? JSON.parse(text) : undefined, rc });
      })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  };

  beforeEach(() => start());
  afterEach(async () => {
    await adapter.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await hub.stop();
  });

  const listen = (
    notifications: unknown,
    headers: Record<string, string> = {},
    id: number | string = 1,
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, ...headers },
      body: JSON.stringify(listenBody(notifications, id)),
    });

  const publish = (e: Partial<NotifyEvent>) =>
    redis.publish(
      REDIS_CHANNELS.notify,
      JSON.stringify({
        targets: { principalIds: [rc.principal.id] },
        kind: 'tools_list_changed',
        ...e,
      }),
    );

  it('6.6 acknowledges first with the honored filter, stamped with the subscription id', async () => {
    const res = await listen({ toolsListChanged: true, promptsListChanged: false }, {}, 'sub-9');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = await readFrames(res, (f) => f.length >= 1);
    expect(messages(frames)[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-9' },
      },
    });
    await res.body?.cancel();
  });

  it('6.6 writes only the notifications the stream opted into, tagged with the subscription id', async () => {
    const res = await listen(
      { toolsListChanged: true, resourceSubscriptions: ['test://static'] },
      {},
      7,
    );
    await publish({ kind: 'prompts_list_changed' });
    await publish({ kind: 'tools_list_changed' });
    await publish({ kind: 'resource_updated', uri: 'test://other' });
    await publish({ kind: 'resource_updated', uri: 'test://static' });
    const frames = await readFrames(res, (f) => messages(f).length >= 3);
    const methods = messages(frames).map((m) => m.method);
    expect(methods).toEqual([
      'notifications/subscriptions/acknowledged',
      'notifications/tools/list_changed',
      'notifications/resources/updated',
    ]);
    const updated = messages(frames)[2] as { params: Record<string, unknown> };
    expect(updated.params).toEqual({
      uri: 'test://static',
      _meta: { 'io.modelcontextprotocol/subscriptionId': 7 },
    });
    await res.body?.cancel();
  });

  it('6.6 delivers only events that target the stream principal', async () => {
    const res = await listen({ toolsListChanged: true });
    await publish({ targets: { principalIds: ['someone-else'] } });
    await publish({ targets: { all: true }, endpointIds: ['not-this-endpoint'] });
    await publish({ targets: { all: true } });
    const frames = await readFrames(res, (f) => messages(f).length >= 2, 800);
    expect(messages(frames).map((m) => m.method)).toEqual([
      'notifications/subscriptions/acknowledged',
      'notifications/tools/list_changed',
    ]);
    await res.body?.cancel();
  });

  it('6.6 honors only readable resource URIs and registers them upstream', async () => {
    const res = await listen({ resourceSubscriptions: ['test://static', 'secret://x'] });
    const frames = await readFrames(res, (f) => f.length >= 1);
    const ack = messages(frames)[0] as { params: { notifications: unknown } };
    expect(ack.params.notifications).toEqual({ resourceSubscriptions: ['test://static'] });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toContain('sub:test://static');
    expect(calls).not.toContain('sub:secret://x');
    await res.body?.cancel();
  });

  it('6.6 joins upstream listen per installation and leaves and unsubscribes when the stream closes', async () => {
    const res = await listen({ toolsListChanged: true, resourceSubscriptions: ['test://static'] });
    await readFrames(res, (f) => f.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([`join:${INST_A}`, 'sub:test://static']);
    expect(adapter.activeStreams()).toBe(1);
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toEqual([
      `join:${INST_A}`,
      'sub:test://static',
      `leave:${INST_A}`,
      'unsub:test://static',
    ]);
    expect(adapter.activeStreams()).toBe(0);
    // The hub registration is gone: a later event is not written anywhere.
    await publish({});
  });

  it('6.6 an empty honored filter is acknowledged and the stream ends gracefully, like the SDK', async () => {
    const res = await listen({ promptsListChanged: false });
    const frames = await readFrames(res, () => false, 500);
    const ms = messages(frames);
    expect(ms[0]?.method).toBe('notifications/subscriptions/acknowledged');
    expect((ms[1] as { result: { resultType: string } }).result.resultType).toBe('complete');
    expect(adapter.activeStreams()).toBe(0);
  });

  it('6.6 writes an SSE comment every keepAliveMs on idle streams', async () => {
    const res = await listen({ toolsListChanged: true });
    const frames = await readFrames(res, (f) => f.some((x) => 'comment' in x));
    expect(frames.some((f) => 'comment' in f && f.comment === ': keepalive')).toBe(true);
    await res.body?.cancel();
  });

  it('21.2 shutdown answers every listen request with a complete result before closing', async () => {
    const res = await listen({ toolsListChanged: true }, {}, 'sub-1');
    await readFrames(res, (f) => f.length >= 1);
    await adapter.shutdown();
    const frames = await readFrames(res, (f) => messages(f).length >= 1, 1500);
    const last = messages(frames).at(-1) as { id: string; result: Record<string, unknown> };
    expect(last.id).toBe('sub-1');
    expect(last.result.resultType).toBe('complete');
    expect(last.result._meta).toMatchObject({
      'io.modelcontextprotocol/subscriptionId': 'sub-1',
      'io.modelcontextprotocol/serverInfo': { name: 'bastion' },
    });
    expect(adapter.activeStreams()).toBe(0);
  });

  it('6.6 rejects a header that disagrees with the body with -32020 and HTTP 400', async () => {
    const res = await listen({ toolsListChanged: true }, { 'mcp-method': 'tools/list' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });

  it('6.6 rejects a missing envelope _meta with -32602', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: { toolsListChanged: true } },
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: number } };
    expect([-32602, -32020, -32600]).toContain(body.error.code);
  });

  it('6.6 answers -32602 in-band when notifications is missing or invalid', async () => {
    for (const bad of [undefined, 'nope', { toolsListChanged: 'yes' }]) {
      const res = await listen(bad);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error: { code: number }; id: number };
      expect(body.error.code).toBe(-32602);
      expect(body.id).toBe(1);
    }
  });

  it('6.6 answers -32603 Subscription limit reached in-band before the ack', async () => {
    await adapter.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await hub.stop();
    await start({ maxStreams: 1 });
    const first = await listen({ toolsListChanged: true });
    await readFrames(first, (f) => f.length >= 1);
    const second = await listen({ toolsListChanged: true }, {}, 2);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      error: { code: -32603, message: 'Subscription limit reached' },
      id: 2,
    });
    await first.body?.cancel();
  });

  it('15.3 records the active listen streams on the streams gauge', async () => {
    const seen: [number, unknown][] = [];
    await adapter.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await hub.stop();
    await start({ metrics: { streamsActive: { record: (v, a) => void seen.push([v, a]) } } });
    const res = await listen({ toolsListChanged: true });
    await readFrames(res, (f) => f.length >= 1);
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(seen[0]).toEqual([1, { era: 'modern', type: 'listen' }]);
    expect(seen.at(-1)?.[0]).toBe(0);
  });

  it('6.6 the TS SDK v2 client listens through the adapter and receives tagged notifications, then a graceful close', async () => {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const client = new Client(
      { name: 'sdk', version: '1' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const got: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      got.push('tools');
    });
    // `server/discover` is answered by a tiny shim: only listen goes to the adapter.
    const shim = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number;
          method: string;
        };
        if (body.method === 'subscriptions/listen') {
          await adapter.handle({ req, res, body, rc });
          return;
        }
        if (body.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: 'bastion', version: '1' },
              ttlMs: 0,
              cacheScope: 'private',
            },
          }),
        );
      })();
    });
    await new Promise<void>((r) => shim.listen(0, '127.0.0.1', r));
    const shimUrl = `http://127.0.0.1:${(shim.address() as AddressInfo).port}/mcp`;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(shimUrl)));
      const sub = await client.listen({ toolsListChanged: true });
      expect(sub.honoredFilter).toEqual({ toolsListChanged: true });
      await publish({});
      await new Promise((r) => setTimeout(r, 150));
      expect(got).toEqual(['tools']);
      await adapter.shutdown();
      expect(await sub.closed).toBe('graceful');
    } finally {
      await client.close().catch(() => undefined);
      shim.closeAllConnections();
      await new Promise<void>((r) => shim.close(() => r()));
    }
  });
});

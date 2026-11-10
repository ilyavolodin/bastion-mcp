import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createListenAdapter } from '../src/adapters/modern/listen';
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

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'subscriptions/listen',
};

const validBody = (over: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'subscriptions/listen',
  params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE },
  ...over,
});

/** The listen adapter behind a bare HTTP server, recording its warnings and upstream calls. */
describe('6.6 listen request rejections (status, body, order, logging)', () => {
  let server: http.Server;
  let url: string;
  let hub: NotifyHub;
  let adapter: ReturnType<typeof createListenAdapter>;
  let warnings: string[];
  let upstreamCalls: string[];

  const start = async (maxStreams?: number) => {
    const redis = new FakeRedis();
    hub = new NotifyHub({ redis });
    await hub.start();
    warnings = [];
    upstreamCalls = [];
    const resolved = await buildEndpoint({
      installations: [installation('a')],
      items: { [INST_A]: items() },
    });
    const rc = requestContext(resolved, { principal: principal() });
    adapter = createListenAdapter({
      hub,
      canReadUri: async () => ({ ok: false }),
      keepAliveMs: 1000,
      maxStreams,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => void warnings.push(message),
        error: () => undefined,
      },
      upstream: {
        joinListen: async () => void upstreamCalls.push('join'),
        leaveListen: async () => void upstreamCalls.push('leave'),
        subscribeResource: async () => void upstreamCalls.push('sub'),
        unsubscribeResource: async () => void upstreamCalls.push('unsub'),
      },
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

  const stop = async () => {
    await adapter.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await hub.stop();
  };

  beforeEach(() => start());
  afterEach(() => stop());

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  };

  it('6.6 a method header that disagrees with the body is rejected by the SDK ladder (400, -32020, id echoed)', async () => {
    const r = await post(validBody(), { 'mcp-method': 'tools/list' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32020 } });
    expect(warnings).toEqual([]);
  });

  it('6.6 an unsupported protocol version is rejected by the ladder with the body id', async () => {
    const r = await post(validBody(), { 'mcp-protocol-version': '1999-01-01' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ jsonrpc: '2.0', id: 7 });
    expect((r.json as { error: { code: number } }).error.code).toBeLessThan(0);
  });

  it('6.6 a body that is not a request for subscriptions/listen is a 400 -32600 with the body id', async () => {
    const notListen = await post(validBody({ method: 'tools/list', params: { _meta: ENVELOPE } }), {
      'mcp-method': 'tools/list',
    });
    expect(notListen.status).toBe(400);
    expect(notListen.json).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid subscriptions/listen request' },
      id: 7,
    });
  });

  it('6.6 a notification (no id) is a 400 -32600 with a null id', async () => {
    const r = await post({
      jsonrpc: '2.0',
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true }, _meta: ENVELOPE },
    });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid subscriptions/listen request' },
      id: null,
    });
  });

  it('6.6 the id may be a string and is echoed on a 400 for a body that fails the schema', async () => {
    const r = await post(validBody({ id: 'abc', jsonrpc: '1.0' }));
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ id: 'abc', error: { code: -32600 } });
  });

  it('6.6 invalid notifications are answered in-band: 200, -32602 with the exact message and the request id', async () => {
    for (const notifications of [undefined, 'nope', { toolsListChanged: 'yes' }, null, []]) {
      const r = await post(validBody({ id: 'sub-1', params: { notifications, _meta: ENVELOPE } }));
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message:
            "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter",
        },
        id: 'sub-1',
      });
    }
    expect(warnings).toEqual([]);
  });

  it('6.6 missing params entirely is the same in-band -32602', async () => {
    const r = await post(validBody({ params: { _meta: ENVELOPE } }));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 7, error: { code: -32602 } });
  });

  it('6.6 the limit check precedes the filter check: at capacity an invalid filter still answers -32603 and logs once', async () => {
    await stop();
    await start(1);
    const first = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(validBody({ id: 1 })),
    });
    const reader = first.body?.getReader();
    await reader?.read();
    expect(adapter.activeStreams()).toBe(1);

    const bad = await post(
      validBody({ id: 2, params: { notifications: 'nope', _meta: ENVELOPE } }),
    );
    expect(bad.status).toBe(200);
    expect(bad.json).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Subscription limit reached' },
      id: 2,
    });
    expect(warnings).toEqual(['subscriptions/listen refused: subscription limit reached']);

    // the ladder and the 400 check come before the limit check
    const invalid = await post(validBody({ method: 'tools/list' }), { 'mcp-method': 'tools/list' });
    expect(invalid.status).toBe(400);
    expect(warnings).toHaveLength(1);
    await reader?.cancel();
  });

  it('6.6 a rejected request opens no stream and calls nothing upstream', async () => {
    await post(validBody({ params: { notifications: 'nope', _meta: ENVELOPE } }));
    expect(adapter.activeStreams()).toBe(0);
    expect(upstreamCalls).toEqual([]);
  });
});

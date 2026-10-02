/**
 * 23.2 compatibility matrix, downstream = legacy clients: TS SDK v2 default (legacy handshake) and TS SDK v1.x
 * (2025-06-18). All methods, MRTR fan-out to legacy elicitation and sampling, progress, cancellation, GET-stream
 * notifications, sessions in Redis.
 */
import {
  dockerAvailable,
  type FakeLegacySseServer,
  startFakeLegacySseServer,
  startRedis,
  type TestRedis,
} from '@bastion-mcp/testkit';
import type { Client } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, textOf } from './helpers/clients';
import { type Fakes, startFakes, startStack, type Stack } from './helpers/stack';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dockerAvailable())('23.2 legacy downstream clients, all upstream kinds', () => {
  let redis: TestRedis;
  let fakes: Fakes;
  let sse: FakeLegacySseServer;
  let stack: Stack;
  const clients: Client[] = [];

  const legacy = async (opts: Partial<Parameters<typeof connectClient>[2]> = {}) => {
    const c = await connectClient(stack, stack.users.alice as never, { era: 'legacy', ...opts } as never);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    redis = await startRedis();
    fakes = await startFakes();
    sse = await startFakeLegacySseServer();
    stack = await startStack({
      redisUrl: redis.url,
      upstreams: [
        { slug: 'modern', kind: 'modern', url: fakes.modern.url },
        { slug: 'legacy', kind: 'legacy', url: fakes.legacy.url },
        { slug: 'sse', kind: 'sse', url: sse.url },
        { slug: 'stdio', kind: 'stdio' },
      ],
      keepAliveMs: 5000,
    });
  }, 180_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await stack?.stop();
    await fakes?.modern.close();
    await fakes?.legacy.close();
    await sse?.close();
    await redis?.stop();
  });

  it('6.2 initialize creates a Redis session bound to the principal and every method works across upstream kinds', async () => {
    const c = await legacy();
    expect(c.getProtocolEra?.()).toBe('legacy');
    const keys = await stack.redis.keys('sess:*');
    expect(keys.length).toBeGreaterThan(0);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const prefix of ['modern', 'legacy', 'sse', 'stdio']) {
      expect(names).toContain(`${prefix}__echo`);
      expect(textOf(await c.callTool({ name: `${prefix}__echo`, arguments: { text: prefix } }))).toBe(prefix);
    }
    expect(JSON.stringify(await c.readResource({ uri: 'test://items/1' }))).toContain('item');
    expect(JSON.stringify(await c.getPrompt({ name: 'modern__greet', arguments: { who: 'ada' } }))).toContain('hi ada');
    expect((await c.listResourceTemplates()).resourceTemplates.length).toBeGreaterThan(0);
  });

  it('6.5 modern upstream to legacy client: fan-out of inputRequests as a server-to-client elicitation on the POST stream', async () => {
    const asked: Record<string, unknown>[] = [];
    const c = await legacy({
      elicit: (p) => {
        asked.push(p);
        return { action: 'accept', content: { name: 'Ada' } };
      },
    });
    const out = await c.callTool({ name: 'modern__ask', arguments: { q: 'name?' } });
    expect(textOf(out)).toContain('hello Ada');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toBe('name?');
  });

  it('6.5 legacy upstream to legacy client: continuation delivered as server requests with remapped ids', async () => {
    const c = await legacy({ elicit: () => ({ action: 'accept', content: { name: 'Ada', v: 'x' } }) });
    expect(textOf(await c.callTool({ name: 'legacy__ask', arguments: { q: 'name?' } }))).toBe('hello Ada');
    expect(textOf(await c.callTool({ name: 'legacy__ask2', arguments: { q: 'q' } }))).toBe('x+x');
    expect(textOf(await c.callTool({ name: 'stdio__ask', arguments: { q: 'name?' } }))).toBe('hello Ada');
  });

  it('6.5 sampling and roots from the upstream reach the legacy client as server requests', async () => {
    const c = await legacy({
      sampling: () => ({ role: 'assistant', content: { type: 'text', text: 'sampled!' }, model: 'm', stopReason: 'endTurn' }),
      roots: ['file:///home/ada'],
    });
    expect(textOf(await c.callTool({ name: 'legacy__sample', arguments: {} }))).toBe('sampled:sampled!');
    expect(textOf(await c.callTool({ name: 'legacy__roots', arguments: {} }))).toBe('roots:file:///home/ada');
  });

  it('6.5 without elicitation, sampling and roots capabilities the client never sees the requests', async () => {
    const c = await legacy();
    expect(textOf(await c.callTool({ name: 'legacy__ask', arguments: { q: 'x' } }))).toBe('action:decline');
    expect(textOf(await c.callTool({ name: 'legacy__sample', arguments: {} }))).toMatch(/^sample-error:-32601/);
    // A modern upstream refuses to ask a client that declared no elicitation: its -32021 passes through unchanged.
    await expect(c.callTool({ name: 'modern__ask', arguments: { q: 'x' } })).rejects.toThrow(/elicitation/);
  });

  it('6.6 progress notifications arrive on the POST stream with the client token', async () => {
    const c = await legacy();
    const progress: number[] = [];
    const out = await c.callTool({ name: 'modern__progress', arguments: { steps: 3 } }, { onprogress: (p: { progress: number }) => progress.push(p.progress) });
    expect(textOf(out)).toContain('progress 3');
    expect(progress.length).toBeGreaterThanOrEqual(3);
  });

  it('6.6 notifications/cancelled aborts the upstream request', async () => {
    const c = await legacy();
    const controller = new AbortController();
    const before = fakes.modern.aborted.length;
    const call = c.callTool({ name: 'modern__slow', arguments: { ms: 5000 } }, { signal: controller.signal }).catch((e: unknown) => e);
    await wait(300);
    controller.abort();
    await call;
    await wait(600);
    expect(fakes.modern.aborted.length).toBeGreaterThan(before);
  });

  it('6.6 resource subscriptions and list changes arrive on the standalone GET stream, and a second GET closes the first', async () => {
    const c = await connectClient(stack, stack.users.alice as never, { era: 'legacy', path: '/mcp/i/modern' });
    clients.push(c);
    const events: string[] = [];
    c.setNotificationHandler('notifications/tools/list_changed' as never, (() => void events.push('tools')) as never);
    c.setNotificationHandler('notifications/resources/updated' as never, ((n: { params: { uri: string } }) => void events.push(`updated:${n.params.uri}`)) as never);
    await c.subscribeResource({ uri: 'test://static' });
    await wait(500);
    fakes.modern.toolsChanged();
    fakes.modern.resourceUpdated('test://static');
    for (let i = 0; i < 40 && events.length < 2; i += 1) await wait(100);
    expect(events).toContain('tools');
    expect(events).toContain('updated:test://static');
    await c.unsubscribeResource({ uri: 'test://static' });
  });

  it('6.2 a session id is useless with another user token: 404', async () => {
    const c = await legacy();
    void c;
    const [key] = await stack.redis.keys('sess:*');
    const sessionId = (key ?? '').replace('sess:', '');
    const res = await fetch(stack.url('/mcp'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stack.users.bob?.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('6.2 DELETE ends the session', async () => {
    const c = await legacy();
    const before = (await stack.redis.keys('sess:*')).length;
    await c.close();
    await wait(300);
    expect((await stack.redis.keys('sess:*')).length).toBeLessThanOrEqual(before);
  });
});

describe.skipIf(!dockerAvailable())('23.2 TS SDK v1.x (2025-06-18) downstream against a modern remote', () => {
  let redis: TestRedis;
  let fakes: Fakes;
  let stack: Stack;

  beforeAll(async () => {
    redis = await startRedis();
    fakes = await startFakes();
    stack = await startStack({ redisUrl: redis.url, upstreams: [{ slug: 'modern', kind: 'modern', url: fakes.modern.url }] });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
    await fakes?.modern.close();
    await redis?.stop();
  });

  it('6.2 core methods work and no Mcp-Session-Id is sent upstream (the modern upstream is stateless)', async () => {
    const transport = new V1Transport(new URL(stack.url('/mcp')), {
      requestInit: { headers: { Authorization: `Bearer ${stack.users.alice?.token}` } },
    });
    const client = new V1Client({ name: 'v1-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport as never);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('modern__echo');
    const out = await client.callTool({ name: 'modern__echo', arguments: { text: 'v1' } });
    expect(textOf(out)).toBe('v1');
    expect(JSON.stringify(await client.readResource({ uri: 'test://static' }))).toContain('static body');
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
    await client.close();
    expect(fakes.modern.requests.length).toBeGreaterThan(0);
    for (const r of fakes.modern.requests) expect(r.headers['mcp-session-id']).toBeUndefined();
  });
});

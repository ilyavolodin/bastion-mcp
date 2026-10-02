/**
 * 23.2 compatibility matrix, downstream = TS SDK v2 with `versionNegotiation: auto` (lands on the modern era):
 * all methods, MRTR through pass-through and through continuations, progress, cancellation and list changes, against
 * a modern remote, a legacy Streamable HTTP remote, a deprecated HTTP+SSE remote and a sandboxed stdio server.
 */
import {
  dockerAvailable,
  type FakeLegacySseServer,
  startFakeLegacySseServer,
  startRedis,
  type TestRedis,
} from '@bastion-mcp/testkit';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, textOf } from './helpers/clients';
import { type Fakes, startFakes, startStack, type Stack } from './helpers/stack';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dockerAvailable())('23.2 TS SDK v2 auto (modern) downstream, all upstream kinds', () => {
  let redis: TestRedis;
  let fakes: Fakes;
  let sse: FakeLegacySseServer;
  let stack: Stack;
  const clients: Client[] = [];

  const modern = async (opts: Parameters<typeof connectClient>[2] extends infer O ? Partial<O> : never = {}) => {
    const c = await connectClient(stack, stack.users.alice as never, { era: 'modern', ...opts } as never);
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

  it('6.3 server/discover and tools/list across modern, legacy HTTP, legacy SSE and stdio upstreams', async () => {
    const c = await modern();
    expect(c.getProtocolEra?.()).toBe('modern');
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const prefix of ['modern', 'legacy', 'sse', 'stdio']) expect(names).toContain(`${prefix}__echo`);
    expect(names).toEqual([...names].sort());
  });

  it('4.4 tools/call reaches every upstream kind', async () => {
    const c = await modern();
    for (const prefix of ['modern', 'legacy', 'sse', 'stdio']) {
      expect(textOf(await c.callTool({ name: `${prefix}__echo`, arguments: { text: prefix } }))).toBe(prefix);
    }
  });

  it('6.3 resources, templates, prompts and completion are routed', async () => {
    const c = await modern();
    const resources = (await c.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain('test://static');
    const read = await c.readResource({ uri: 'test://static' });
    expect(JSON.stringify(read.contents)).toContain('body');
    expect(JSON.stringify(await c.readResource({ uri: 'test://items/7' }))).toContain('item');
    const templates = (await c.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('test://items/{id}');
    const prompt = await c.getPrompt({ name: 'modern__greet', arguments: { who: 'ada' } });
    expect(JSON.stringify(prompt.messages)).toContain('hi ada');
    const completion = await c.complete({
      ref: { type: 'ref/prompt', name: 'legacy__greet' },
      argument: { name: 'who', value: 'a' },
    });
    expect(completion.completion.values).toEqual(['alpha', 'beta']);
  });

  it('6.5 modern upstream to modern client: stateless pass-through of input_required with a wrapped requestState', async () => {
    const seen: Record<string, unknown>[] = [];
    const c = await modern({
      elicit: (params) => {
        seen.push(params);
        return { action: 'accept', content: { name: 'Ada' } };
      },
    });
    const out = await c.callTool({ name: 'modern__ask', arguments: { q: 'name?' } });
    expect(textOf(out)).toContain('hello Ada');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe('name?');
  });

  it('6.5 legacy upstream to modern client: continuation, including two parallel elicitations', async () => {
    const answers = ['one', 'two'];
    const c = await modern({
      elicit: (params) => ({
        action: 'accept',
        content: String(params.message).endsWith('1') || params.message === 'name?' ? { name: 'Ada', v: answers[0] } : { v: answers[1] },
      }),
    });
    expect(textOf(await c.callTool({ name: 'legacy__ask', arguments: { q: 'name?' } }))).toBe('hello Ada');
    expect(textOf(await c.callTool({ name: 'legacy__ask2', arguments: { q: 'q' } }))).toBe('one+two');
  });

  it('6.5 stdio upstream in a sandbox: continuation through the owner worker', async () => {
    const c = await modern({ elicit: () => ({ action: 'accept', content: { name: 'Grace' } }) });
    expect(textOf(await c.callTool({ name: 'stdio__ask', arguments: { q: 'name?' } }))).toBe('hello Grace');
  });

  it('6.5 sampling and roots of a legacy upstream reach the modern client as input requests', async () => {
    const c = await modern({
      sampling: () => ({ role: 'assistant', content: { type: 'text', text: 'sampled!' }, model: 'm', stopReason: 'endTurn' }),
      roots: ['file:///home/ada'],
    });
    expect(textOf(await c.callTool({ name: 'legacy__sample', arguments: {} }))).toBe('sampled:sampled!');
    expect(textOf(await c.callTool({ name: 'legacy__roots', arguments: {} }))).toBe('roots:file:///home/ada');
  });

  it('6.5 a client without sampling or roots never sees those requests: Bastion answers -32601 and the configured roots', async () => {
    const c = await modern();
    expect(textOf(await c.callTool({ name: 'legacy__sample', arguments: {} }))).toMatch(/^sample-error:-32601/);
    expect(textOf(await c.callTool({ name: 'legacy__roots', arguments: {} }))).toBe('roots:');
    expect(textOf(await c.callTool({ name: 'legacy__ask', arguments: { q: 'x' } }))).toBe('action:decline');
  });

  it('6.6 progress notifications reach the client with its own token', async () => {
    const c = await modern();
    for (const prefix of ['modern', 'legacy']) {
      const progress: number[] = [];
      const out = await c.callTool(
        { name: `${prefix}__progress`, arguments: { steps: 3 } },
        { onprogress: (p: { progress: number }) => progress.push(p.progress) },
      );
      expect(textOf(out)).toContain('progress 3');
      expect(progress.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('6.6 closing the request aborts the upstream call', async () => {
    const c = await modern();
    const controller = new AbortController();
    const before = fakes.modern.aborted.length;
    const call = c.callTool({ name: 'modern__slow', arguments: { ms: 5000 } }, { signal: controller.signal }).catch((e: unknown) => e);
    await wait(300);
    controller.abort();
    await call;
    await wait(500);
    expect(fakes.modern.aborted.length).toBeGreaterThan(before);
  });

  it('6.6 subscriptions/listen delivers list_changed and resources/updated from the upstream, filtered per stream', async () => {
    const c = await modern({ path: '/mcp/i/modern' });
    const events: string[] = [];
    c.setNotificationHandler('notifications/tools/list_changed' as never, (() => void events.push('tools')) as never);
    c.setNotificationHandler('notifications/prompts/list_changed' as never, (() => void events.push('prompts')) as never);
    c.setNotificationHandler('notifications/resources/updated' as never, ((n: { params: { uri: string } }) => void events.push(`updated:${n.params.uri}`)) as never);
    const sub = await c.listen({ toolsListChanged: true, resourceSubscriptions: ['test://static'] });
    expect(sub.honoredFilter.resourceSubscriptions).toEqual(['test://static']);
    await wait(500);
    fakes.modern.toolsChanged();
    fakes.modern.resourceUpdated('test://static');
    for (let i = 0; i < 40 && events.length < 2; i += 1) await wait(100);
    expect(events).toContain('tools');
    expect(events).toContain('updated:test://static');
    expect(events).not.toContain('prompts');
    await sub.close();
  });

  it('6.8 MCP Apps: _meta.ui of a tool and ui:// resources pass through unchanged', async () => {
    const c = await modern();
    const widget = (await c.listTools()).tools.find((t) => t.name === 'modern__widget');
    expect((widget?._meta as { ui?: { resourceUri?: string; csp?: unknown } }).ui?.resourceUri).toBe('ui://widget/main');
    expect(JSON.stringify((widget?._meta as { ui?: unknown }).ui)).toContain('api.example.com');
    await c.callTool({ name: 'modern__widget', arguments: {} });
    const read = await c.readResource({ uri: 'ui://widget/main' });
    expect(JSON.stringify(read.contents)).toContain('<html><body>widget</body></html>');
    expect(JSON.stringify(read.contents)).toContain('text/html;profile=mcp-app');
  });

  it('7.1 single-installation endpoints keep upstream names and every kind works through /mcp/i/{slug}', async () => {
    for (const slug of ['modern', 'legacy', 'sse', 'stdio']) {
      const c = await modern({ path: `/mcp/i/${slug}` });
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toContain('echo');
      expect(textOf(await c.callTool({ name: 'echo', arguments: { text: slug } }))).toBe(slug);
    }
  });

  it('15.5 every routed call left a call-log row with the final and upstream names', async () => {
    const rows = stack.rows.filter((r) => r.method === 'tools/call' && r.itemName === 'modern__echo');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ upstreamName: 'echo', outcome: 'ok', eraDown: 'modern', principalType: 'user' });
  });
});

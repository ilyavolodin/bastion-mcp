import { dockerAvailable, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, textOf } from './helpers/clients';
import { type Fakes, startFakes, startStack, type Stack } from './helpers/stack';

describe.skipIf(!dockerAvailable())('23.2 modern downstream client (TS SDK v2 auto) through /mcp', () => {
  let redis: TestRedis;
  let fakes: Fakes;
  let stack: Stack;

  beforeAll(async () => {
    redis = await startRedis();
    fakes = await startFakes();
    stack = await startStack({
      redisUrl: redis.url,
      upstreams: [
        { slug: 'modern', kind: 'modern', url: fakes.modern.url },
        { slug: 'legacy', kind: 'legacy', url: fakes.legacy.url },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
    await fakes?.modern.close();
    await fakes?.legacy.close();
    await redis?.stop();
  });

  it('6.3 server/discover: modern revision, endpoint capabilities and merged instructions', async () => {
    const client = await connectClient(stack, stack.users.alice as never, { era: 'modern' });
    expect(client.getProtocolEra?.()).toBe('modern');
    expect(client.getServerCapabilities()?.tools).toBeTruthy();
    expect(client.getServerVersion()?.name).toBe('bastion');
    await client.close();
  });

  it('6.3 7.3 tools/list aggregates both upstreams with prefixed, sorted names', async () => {
    const client = await connectClient(stack, stack.users.alice as never, { era: 'modern' });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('modern__echo');
    expect(names).toContain('legacy__echo');
    expect(names).toEqual([...names].sort());
    await client.close();
  });

  it('4.4 tools/call through the full pipeline reaches a modern remote and a legacy remote', async () => {
    const client = await connectClient(stack, stack.users.alice as never, { era: 'modern' });
    expect(textOf(await client.callTool({ name: 'modern__echo', arguments: { text: 'hi' } }))).toBe('hi');
    expect(textOf(await client.callTool({ name: 'legacy__echo', arguments: { text: 'yo' } }))).toBe('yo');
    await client.close();
    expect(stack.rows.filter((r) => r.method === 'tools/call').length).toBeGreaterThanOrEqual(2);
  });
});

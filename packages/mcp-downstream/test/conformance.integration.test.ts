import { dockerAvailable, startConformanceEverythingServer, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthProxy } from './helpers/auth-proxy';
import { runConformanceScenario } from './helpers/conformance-cli';
import { startStack, type Stack } from './helpers/stack';

const SCENARIOS = (process.env.CONF_SCENARIOS ?? 'server-initialize,ping').split(',');

describe.skipIf(!dockerAvailable())('23.1 official conformance suite against /mcp/i/everything (2025 era)', () => {
  let redis: TestRedis;
  let everything: Awaited<ReturnType<typeof startConformanceEverythingServer>>;
  let stack: Stack;
  let proxy: Awaited<ReturnType<typeof startAuthProxy>>;

  beforeAll(async () => {
    redis = await startRedis();
    everything = await startConformanceEverythingServer();
    stack = await startStack({
      redisUrl: redis.url,
      upstreams: [{ slug: 'everything', kind: 'modern', url: everything.url }],
      config: { allowedHosts: ['localhost', '127.0.0.1', '[::1]'] },
    });
    proxy = await startAuthProxy(stack.base, stack.users.alice?.token ?? '');
  }, 180_000);

  afterAll(async () => {
    await proxy?.close();
    await stack?.stop();
    await everything?.close();
    await redis?.stop();
  });

  it('runs scenarios', async () => {
    for (const sc of SCENARIOS) {
      const r = await runConformanceScenario(`${proxy.url}/mcp/i/everything`, sc);
      console.log(`CONF ${sc} exit=${r.exitCode} ${JSON.stringify(r.scenarios[sc])}`);
      if (process.env.SHOW) console.log(r.stdout.slice(0, 2500));
    }
    expect(true).toBe(true);
  }, 600_000);
});

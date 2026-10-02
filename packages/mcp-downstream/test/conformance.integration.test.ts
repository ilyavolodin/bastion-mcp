/**
 * 23.1 protocol conformance: `@modelcontextprotocol/conformance` 0.1.16 `server --url .../mcp/i/everything` against a
 * running gateway whose upstream is a modern remote "everything" server (the conformance fixtures, with sampling and
 * elicitation as multi round trip results). The suite's client is the TS SDK v1 client, so it exercises the 2025-era
 * transport (2025-06-18 and 2025-11-25 scenarios). Release 0.1.16 has no 2026-07-28 server scenarios: the modern leg is
 * covered by the SDK v2 matrix tests. An auth proxy adds the bearer token because the CLI cannot send headers.
 */
import { dockerAvailable, startConformanceEverythingServer, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthProxy } from './helpers/auth-proxy';
import { runConformanceScenario } from './helpers/conformance-cli';
import { startStack, type Stack } from './helpers/stack';

/** Scenarios that must pass without a failed check. */
const PASSING = [
  'server-initialize',
  'logging-set-level',
  'ping',
  'completion-complete',
  'tools-list',
  'tools-call-simple-text',
  'tools-call-image',
  'tools-call-audio',
  'tools-call-embedded-resource',
  'tools-call-mixed-content',
  'tools-call-with-logging',
  'tools-call-error',
  'tools-call-with-progress',
  'tools-call-sampling',
  'tools-call-elicitation',
  'json-schema-2020-12',
  'elicitation-sep1034-defaults',
  'server-sse-multiple-streams',
  'elicitation-sep1330-enums',
  'resources-list',
  'resources-read-text',
  'resources-read-binary',
  'resources-templates-read',
  'resources-subscribe',
  'resources-unsubscribe',
  'prompts-list',
  'prompts-get-simple',
  'prompts-get-with-args',
  'prompts-get-embedded-resource',
  'prompts-get-with-image',
  'dns-rebinding-protection',
];

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
      named: (ids) => [{ id: 'flat', kind: 'named', slug: 'flat', installationIds: ids, prefixMode: 'onCollision' }],
    });
    proxy = await startAuthProxy(stack.base, stack.users.alice?.token ?? '');
  }, 180_000);

  afterAll(async () => {
    await proxy?.close();
    await stack?.stop();
    await everything?.close();
    await redis?.stop();
  });

  for (const scenario of PASSING) {
    it(`23.1 conformance scenario ${scenario} passes on /mcp/i/everything`, async () => {
      const report = await runConformanceScenario(`${proxy.url}/mcp/i/everything`, scenario);
      const checks = report.scenarios[scenario] ?? [];
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
      expect(report.exitCode).toBe(0);
    }, 90_000);
  }

  for (const scenario of PASSING) {
    it(`23.1 7.1 conformance scenario ${scenario} passes on the named endpoint /mcp/e/flat (prefixMode onCollision)`, async () => {
      const report = await runConformanceScenario(`${proxy.url}/mcp/e/flat`, scenario);
      const checks = report.scenarios[scenario] ?? [];
      expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
      expect(report.exitCode).toBe(0);
    }, 90_000);
  }

  /** The default endpoint prefixes every name (7.3), so only scenarios that do not name items can pass there. */
  const NAME_INDEPENDENT = [
    'server-initialize',
    'logging-set-level',
    'ping',
    'tools-list',
    'server-sse-multiple-streams',
    'resources-list',
    'resources-read-text',
    'resources-read-binary',
    'resources-templates-read',
    'resources-subscribe',
    'resources-unsubscribe',
    'prompts-list',
    'dns-rebinding-protection',
  ];
  for (const scenario of NAME_INDEPENDENT) {
    it(`23.1 7.3 conformance scenario ${scenario} passes on the default endpoint /mcp`, async () => {
      const report = await runConformanceScenario(`${proxy.url}/mcp`, scenario);
      const checks = report.scenarios[scenario] ?? [];
      expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
      expect(report.exitCode).toBe(0);
    }, 90_000);
  }

  it('23.1 server-sse-polling: no failures; resumability is not offered by design (6.2 sends no event ids), so only recommendations warn', async () => {
    const report = await runConformanceScenario(`${proxy.url}/mcp/i/everything`, 'server-sse-polling');
    const checks = report.scenarios['server-sse-polling'] ?? [];
    expect(checks.filter((c) => c.status === 'FAILURE')).toEqual([]);
    expect(checks.filter((c) => c.status === 'WARNING').map((c) => c.message)).toEqual([
      expect.stringContaining('priming event'),
      expect.stringContaining('retry field'),
    ]);
  }, 90_000);
});

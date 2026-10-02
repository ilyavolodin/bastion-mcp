import { type FakeModernServer, startFakeModernServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import {
  connectClient,
  seedInstallation,
  startTestWorker,
  type TestWorker,
  textOf,
} from './helpers/worker-harness';

describe.skipIf(!haveDocker())('4.4 worker role: MCP through the real pipeline', () => {
  let env: TestEnv;
  let worker: TestWorker;
  let upstream: FakeModernServer;
  let seeded: Awaited<ReturnType<typeof seedInstallation>>;

  beforeAll(async () => {
    env = await createTestEnv();
    upstream = await startFakeModernServer();
    worker = await startTestWorker(env);
    seeded = await seedInstallation(worker.infra, {
      email: 'alice@example.com',
      slug: 'fake',
      spec: {
        type: 'remote',
        transport: 'streamable-http',
        url: `${upstream.url}`,
        auth: { mode: 'none' },
      },
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await upstream?.close();
    await env?.cleanup();
  });

  it('4.4 tools/list shows the prefixed upstream tools and tools/call reaches the upstream', async () => {
    const client = await connectClient(worker.base, seeded.userId);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('fake__echo');
      const result = await client.callTool({ name: 'fake__echo', arguments: { text: 'hello' } });
      expect(textOf(result)).toBe('hello');
    } finally {
      await client.close();
    }
  });

  it('15.5 the call is written to call_log through the batched writer', async () => {
    const client = await connectClient(worker.base, seeded.userId);
    try {
      await client.callTool({ name: 'fake__echo', arguments: { text: 'logged' } });
    } finally {
      await client.close();
    }
    await expect
      .poll(
        async () => {
          const page = await worker.infra.repos.callLog.list({ limit: 50 });
          return page.items.filter((r) => r.method === 'tools/call').length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  });

  it('9.3 a token of an unknown user is rejected with a Bearer challenge', async () => {
    const res = await fetch(`${worker.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok:00000000-0000-4000-8000-000000000000',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });
});

/**
 * Split mode (4.2, 21): a `ui` process and two `worker` processes share Postgres and Redis. Proves the path groups of
 * each role, the catalog TEST flow of a ui-only process (no worker in the process), and the forwarding of an owner-held
 * legacy remote instance between two workers.
 */
import { redisKeys } from '@bastion-mcp/core';
import { type FakeLegacyHttpServer, startFakeLegacyHttpServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { type FakeIdp, startFakeIdp } from './helpers/fake-idp';
import {
  api,
  connectWithToken,
  eventually,
  loginAs,
  PUBLIC_ORIGIN,
  seedIdp,
  textOf,
} from './helpers/journey';
import { proxyFetch } from './helpers/proxy-fetch';
import { bootStack, type Stack } from './helpers/stack';
import type { Browser } from './helpers/ui-harness';

type Item = Record<string, unknown>;

describe.skipIf(!haveDocker())('E2E split mode: ui + two workers (4.2, 6.5, 21)', () => {
  let env: TestEnv;
  let idp: FakeIdp;
  let upstream: FakeLegacyHttpServer;
  let ui: Stack;
  let w1: Stack;
  let w2: Stack;
  let admin: Browser;
  const ingress = { port: 0 };
  let pat = '';
  let installationId = '';

  const base = (s: Stack): string => `http://127.0.0.1:${s.port}`;

  beforeAll(async () => {
    env = await createTestEnv();
    idp = await startFakeIdp();
    upstream = await startFakeLegacyHttpServer();
    // The ui process reaches its own public URL through the ingress; here that is the first worker.
    const viaIngress: typeof fetch = (input, init) => proxyFetch(ingress.port)(input, init);
    ui = await bootStack({ env, role: 'ui', workerId: 'ui-1', options: { fetch: viaIngress } });
    await seedIdp(ui.server.infra, idp);
    w1 = await bootStack({ env, role: 'worker', workerId: 'worker-one' });
    ingress.port = w1.port;
    w2 = await bootStack({ env, role: 'worker', workerId: 'worker-two' });
  });
  afterAll(async () => {
    await Promise.all([w1?.stop(), w2?.stop()]);
    await ui?.stop();
    await upstream?.close();
    await idp?.close();
    await env?.cleanup();
  });

  it('4.2 path routing: workers serve /mcp and protected-resource metadata, the ui serves everything else', async () => {
    const wMcp = await w1.fetch(`${PUBLIC_ORIGIN}/mcp`, { method: 'POST', body: '{}' });
    expect(wMcp.status).toBe(401);
    expect(
      (await w1.fetch(`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`)).status,
    ).toBe(200);
    // The worker does not serve the management API, the AS or the SPA.
    expect((await w1.fetch(`${PUBLIC_ORIGIN}/api/v1/me`)).status).toBe(404);
    expect((await w1.fetch(`${PUBLIC_ORIGIN}/oauth/.well-known/openid-configuration`)).status).toBe(
      404,
    );
    // The ui serves the API and the AS, and answers 404 (never the SPA) for the worker paths.
    expect((await ui.fetch(`${PUBLIC_ORIGIN}/api/v1/me`)).status).toBe(401);
    expect(
      (await ui.fetch(`${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server/oauth`)).status,
    ).toBe(200);
    expect((await ui.fetch(`${PUBLIC_ORIGIN}/mcp`, { method: 'POST', body: '{}' })).status).toBe(
      404,
    );
    // Both answer the probes.
    for (const s of [ui, w1, w2]) {
      expect((await s.fetch(`${PUBLIC_ORIGIN}/healthz`)).status).toBe(200);
    }
    const ready = (await (await w1.fetch(`${PUBLIC_ORIGIN}/readyz`)).json()) as {
      checks: Record<string, unknown>;
    };
    expect(Object.keys(ready.checks)).toEqual(expect.arrayContaining(['internal-rpc', 'sandbox']));
    const uiReady = (await (await ui.fetch(`${PUBLIC_ORIGIN}/readyz`)).json()) as {
      checks: Record<string, unknown>;
    };
    expect(Object.keys(uiReady.checks)).not.toContain('internal-rpc');
  });

  it('21.1 the worker registry lists both workers', async () => {
    const keys = await eventually(async () => {
      const found = await w1.server.infra.redis.keys(redisKeys.worker('*'));
      return found.length >= 2 ? found : undefined;
    });
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it('11.2 a ui-only process creates, tests (through a worker) and publishes a legacy remote entry', async () => {
    admin = await loginAs(base(ui), idp, {
      sub: 'idp-ada',
      email: 'ada@acme.example',
      name: 'Ada Admin',
      groups: ['bastion-admins'],
    });
    const entry = await api(admin, 'POST', '/catalog', {
      slug: 'legacy',
      displayName: 'Legacy upstream',
      visibility: { org: true, teamIds: [], userIds: [] },
      risk: 'low',
    });
    expect(entry.status).toBe(201);
    const entryId = String((entry.body as Item).id);
    const version = await api(admin, 'POST', `/catalog/${entryId}/versions`, {
      label: '1',
      serverSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: upstream.url,
        auth: { mode: 'none' },
      },
    });
    const versionId = String((version.body as Item).id);
    expect(
      (await api(admin, 'POST', `/catalog/${entryId}/versions/${versionId}/test`)).status,
    ).toBe(202);
    await eventually(
      async () => {
        const res = await admin.request(
          `${PUBLIC_ORIGIN}/api/v1/catalog/${entryId}/versions/${versionId}/test`,
          {
            headers: { accept: 'text/event-stream' },
          },
        );
        const last = (await res.text())
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5).trim()) as { status?: string })
          .at(-1);
        return last?.status === 'passed' ? true : undefined;
      },
      { timeoutMs: 40_000 },
    );
    expect(
      (await api(admin, 'POST', `/catalog/${entryId}/versions/${versionId}/publish`)).status,
    ).toBe(200);
    const install = await api(admin, 'POST', '/installations', { catalogEntryId: entryId });
    expect(install.status).toBe(201);
    installationId = String((install.body as Item).id);
    const token = await api(admin, 'POST', '/tokens', { name: 'split', scopes: ['mcp'] });
    pat = String((token.body as Item).token);
  });

  it('6.5, 21.2 an owner-held legacy remote instance is called through both workers over one upstream session', async () => {
    const c1 = await connectWithToken(base(w1), pat, { era: 'legacy' });
    const first = await c1.callTool({ name: 'legacy__echo', arguments: { text: 'one' } });
    expect(textOf(first)).toContain('one');
    const sessions = upstream.initializeCount();
    const instance = await ui.server.infra.repos.instances.getForInstallation(installationId);
    expect(instance).not.toBeNull();
    const lease = await ui.server.infra.redis.get(redisKeys.lease(instance?.id ?? ''));
    const owner = lease?.includes('worker-one') ? 'worker-one' : 'worker-two';
    const other = owner === 'worker-one' ? w2 : w1;
    const c2 = await connectWithToken(base(other), pat, { era: 'legacy' });
    const second = await c2.callTool({ name: 'legacy__echo', arguments: { text: 'two' } });
    expect(textOf(second)).toContain('two');
    expect(upstream.initializeCount()).toBe(sessions);
    await c1.close();
    await c2.close();
  });

  it('21.2 SIGTERM on the lease owner drains it; the other worker takes the instance over', async () => {
    const instance = await ui.server.infra.repos.instances.getForInstallation(installationId);
    const lease = await ui.server.infra.redis.get(redisKeys.lease(instance?.id ?? ''));
    const ownerStack = lease?.includes('worker-one') ? w1 : w2;
    const survivor = ownerStack === w1 ? w2 : w1;
    await ownerStack.stop();
    const client = await connectWithToken(base(survivor), pat, { era: 'legacy' });
    try {
      const result = await eventually(async () => {
        const r = await client
          .callTool({ name: 'legacy__echo', arguments: { text: 'after' } })
          .catch(() => undefined);
        return r && textOf(r).includes('after') ? r : undefined;
      });
      expect(textOf(result)).toContain('after');
    } finally {
      await client.close();
    }
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyStoreOf } from '../src/boot/key-store';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { bootStack, type Stack } from './helpers/stack';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

describe.skipIf(!haveDocker())('E2E boot: all-in-one server (4.1, 4.2, 15.1, 20.1)', () => {
  let env: TestEnv;
  let stack: Stack;
  const printed: { email: string; password: string }[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    stack = await bootStack({
      env,
      vars: { BASTION_BOOTSTRAP_ADMIN_EMAIL: 'root@acme.example', BASTION_LOCAL_LOGIN: 'true' },
      options: {
        publicDir: WEB_DIST,
        printBootstrapPassword: (email, password) => printed.push({ email, password }),
      },
    });
  });
  afterAll(async () => {
    await stack?.stop();
    await env?.cleanup();
  });

  it('20.1 boot applies/accepts migrations, seeds defaults and creates the bootstrap admin once', async () => {
    expect(printed).toHaveLength(1);
    expect(printed[0]?.email).toBe('root@acme.example');
    const users = await stack.server.infra.repos.users.count();
    expect(users).toBe(1);
    const keys = await keyStoreOf(stack.server.infra).listSigningKeys('as');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('15.1 /healthz is live and /readyz reports every check', async () => {
    expect((await stack.fetch(stack.url('/healthz'))).status).toBe(200);
    const res = await stack.fetch(stack.url('/readyz'));
    const body = (await res.json()) as { ok: boolean; checks: Record<string, { ok: boolean }> };
    expect(Object.keys(body.checks)).toEqual(
      expect.arrayContaining(['postgres', 'redis', 'migrations', 'sandbox', 'internal-rpc']),
    );
    expect(body.checks.postgres?.ok).toBe(true);
    expect(body.checks.redis?.ok).toBe(true);
    expect(body.checks.migrations?.ok).toBe(true);
    expect(res.status).toBe(body.ok ? 200 : 503);
  });

  it('9.2, 24.2 the SPA is served at / with a strict CSP, HSTS and no framing', async () => {
    const res = await stack.fetch(stack.url('/'), { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    const fallback = await stack.fetch(stack.url('/catalog/some-route'), {
      headers: { accept: 'text/html' },
    });
    expect(fallback.status).toBe(200);
    const api404 = await stack.fetch(stack.url('/api/v1/nope'), {
      headers: { accept: 'application/json' },
    });
    expect([401, 404]).toContain(api404.status);
  });

  it('4.2 worker and ui path groups are served by one process: protected-resource metadata and AS metadata', async () => {
    const prm = await stack.fetch(stack.url('/.well-known/oauth-protected-resource/mcp'));
    expect(prm.status).toBe(200);
    expect(
      ((await prm.json()) as { authorization_servers: string[] }).authorization_servers,
    ).toEqual(['https://bastion.test/oauth']);
    const as = await stack.fetch(stack.url('/.well-known/oauth-authorization-server/oauth'));
    expect(as.status).toBe(200);
    const unauth = await stack.fetch(stack.url('/mcp'), { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
  });
});

/**
 * Backup, restore and maintenance mode through the running server: the console API as a signed-in administrator
 * (session cookie plus CSRF header), and the gate that stops gateway traffic while maintenance mode is on.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { bootStack, type Stack } from './helpers/stack';

const PASS = 'a long enough passphrase';

describe.skipIf(!haveDocker())('backup and maintenance over HTTP', () => {
  let env: TestEnv;
  let stack: Stack;
  let cookies = '';
  let csrf = '';
  let email = '';
  let password = '';

  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { accept: 'application/json', cookie: cookies };
    if (method !== 'GET') {
      headers['x-bastion-csrf'] = csrf;
      headers['idempotency-key'] = randomBytes(12).toString('hex');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await stack.fetch(stack.url(`/api/v1${path}`), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };

  beforeAll(async () => {
    env = await createTestEnv();
    const printed: { email: string; password: string }[] = [];
    stack = await bootStack({
      env,
      vars: { BASTION_BOOTSTRAP_ADMIN_EMAIL: 'root@acme.example', BASTION_LOCAL_LOGIN: 'true' },
      options: { printBootstrapPassword: (e, p) => printed.push({ email: e, password: p }) },
    });
    email = printed[0]?.email ?? '';
    password = printed[0]?.password ?? '';
    const login = await stack.fetch(stack.url('/auth/local'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const set = login.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
    cookies = set.join('; ');
    csrf = set.find((c) => c.startsWith('bastion_csrf='))?.slice('bastion_csrf='.length) ?? '';
    expect(cookies).toContain('bastion_sid=');
  });
  afterAll(async () => {
    await stack?.stop();
    await env?.cleanup();
  });

  it('creates a backup as base64, audits the export, and previews a restore of it', async () => {
    const made = await call('POST', '/system/backup', { passphrase: PASS });
    expect(made.status).toBe(200);
    expect(String(made.body.filename)).toMatch(/\.bastion-backup$/);
    expect((made.body.counts as Record<string, number>).users).toBe(1);
    const data = String(made.body.data);
    expect(Buffer.from(data, 'base64').subarray(0, 8).toString()).toBe('BSTNBK01');

    const audit = await stack.server.infra.db.prisma.auditEvent.findFirst({
      where: { action: 'backup.export' },
    });
    expect(audit?.diff).toMatchObject({ counts: { users: 1 } });

    const preview = await call('POST', '/system/restore', {
      data,
      passphrase: PASS,
      mode: 'merge',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect((preview.body.tables as Record<string, { rows: number }>).users?.rows).toBe(1);
    expect(preview.body.dryRun).toBe(true);
  });

  it('rejects a short passphrase, a wrong passphrase and garbage', async () => {
    const short = await call('POST', '/system/backup', { passphrase: 'short' });
    expect(short.status).toBe(400);
    const made = await call('POST', '/system/backup', { passphrase: PASS });
    const data = String(made.body.data);
    const wrong = await call('POST', '/system/restore', {
      data,
      passphrase: 'another passphrase',
      mode: 'merge',
      dryRun: true,
    });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.detail ?? wrong.body.title)).toMatch(/passphrase/);
    const junk = await call('POST', '/system/restore', {
      data: Buffer.from('not a backup').toString('base64'),
      passphrase: PASS,
      mode: 'merge',
      dryRun: true,
    });
    expect(junk.status).toBe(400);
  });

  it('maintenance mode answers 503 on the gateway and console writes, keeps health, reads and system routes', async () => {
    expect((await call('GET', '/system/maintenance')).body.enabled).toBe(false);
    expect((await stack.fetch(stack.url('/mcp'), { method: 'POST', body: '{}' })).status).toBe(401);

    const on = await call('POST', '/system/maintenance', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);

    const gateway = await stack.fetch(stack.url('/mcp'), { method: 'POST', body: '{}' });
    expect(gateway.status).toBe(503);
    expect(gateway.headers.get('retry-after')).toBe('60');
    expect((await stack.fetch(stack.url('/oauth/token'), { method: 'POST' })).status).toBe(503);
    expect((await call('POST', '/teams', { slug: 'x', displayName: 'X' })).status).toBe(503);
    expect((await call('GET', '/teams')).status).toBe(200);
    expect((await stack.fetch(stack.url('/healthz'))).status).toBe(200);
    expect((await call('GET', '/system/maintenance')).body.enabled).toBe(true);

    const off = await call('POST', '/system/maintenance', { enabled: false });
    expect(off.body.enabled).toBe(false);
    // Other replicas notice within the cache window (1 s); until then they stay closed.
    await expect
      .poll(
        async () => (await stack.fetch(stack.url('/mcp'), { method: 'POST', body: '{}' })).status,
        {
          timeout: 5_000,
        },
      )
      .toBe(401);
    const trail = await stack.server.infra.db.prisma.auditEvent.findMany({
      where: { action: { startsWith: 'maintenance.' } },
      orderBy: { seq: 'asc' },
    });
    expect(trail.map((a) => a.action)).toEqual(['maintenance.enable', 'maintenance.disable']);
  });

  it('a replace is refused (409) until maintenance mode is on, then restores and keeps the admin signed in', async () => {
    const made = await call('POST', '/system/backup', { passphrase: PASS });
    const data = String(made.body.data);
    const body = { data, passphrase: PASS, mode: 'replace', dryRun: false };

    const refused = await call('POST', '/system/restore', body);
    expect(refused.status).toBe(409);
    expect(refused.body.code ?? refused.body.type).toMatch(/restore_maintenance_required/);

    await call('POST', '/system/maintenance', { enabled: true });
    const done = await call('POST', '/system/restore', body);
    expect(done.status).toBe(200);
    expect(done.body.mode).toBe('replace');

    // The administrator is in the backup, so the same session still works afterwards.
    expect((await call('GET', '/system/maintenance')).status).toBe(200);
    const last = await stack.server.infra.db.prisma.auditEvent.findFirst({
      orderBy: { seq: 'desc' },
    });
    expect(last?.action).toBe('backup.restore.replace');
    await call('POST', '/system/maintenance', { enabled: false });
  });
});

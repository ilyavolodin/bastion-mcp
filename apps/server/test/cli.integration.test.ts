import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, newId } from '@bastion-mcp/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDefaults } from '../src/boot/seed';
import { execute, isCliCommand, runCli } from '../src/cli';
import { HELP, parseArgs } from '../src/cli/commands';
import { createInfra, type Infra } from '../src/infra';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const capture = (stdin = '') => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (l: string) => void out.push(l),
      err: (l: string) => void err.push(l),
      stdin: async () => stdin,
    },
  };
};

describe('20.1 CLI argument parsing', () => {
  it('20.1 the default command is serve and flags take values', () => {
    expect(parseArgs([]).command).toBe('serve');
    const p = parseArgs(['rotate-keys', '--purpose', 'as', '--force', '--email=a@b.c']);
    expect(p.command).toBe('rotate-keys');
    expect(p.flags.get('purpose')).toBe('as');
    expect(p.flags.get('force')).toBe(true);
    expect(p.flags.get('email')).toBe('a@b.c');
    expect(isCliCommand([])).toBe(false);
    expect(isCliCommand(['serve'])).toBe(false);
    expect(isCliCommand(['migrate'])).toBe(true);
    expect(isCliCommand(['--help'])).toBe(true);
  });

  it('20.1 --help prints the command list and exits 0', async () => {
    const c = capture();
    expect(await execute(['--help'], {}, c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('export-config');
    expect(HELP).toContain('rotate-keys');
    expect(await runCli(['help'], {})).toBe(0);
  });

  it('20.1 an unknown command exits 2', async () => {
    const c = capture();
    expect(await execute(['frobnicate'], {}, c.io)).toBe(2);
  });
});

describe.skipIf(!haveDocker())('20.1 CLI commands against Postgres and Redis', () => {
  let env: TestEnv;
  let infra: Infra;
  let tmp: string;

  beforeAll(async () => {
    env = await createTestEnv();
    tmp = mkdtempSync(join(tmpdir(), 'bastion-cli-'));
    infra = createInfra(loadConfig(env.env()));
  });
  afterAll(async () => {
    await infra.close();
    rmSync(tmp, { recursive: true, force: true });
    await env.cleanup();
  });

  const freshEnv = async (): Promise<{
    env: Record<string, string>;
    cleanup: () => Promise<void>;
  }> => {
    const base = env.env();
    const admin = new pg.Client({ connectionString: base.BASTION_DATABASE_URL });
    await admin.connect();
    const name = `cli_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(base.BASTION_DATABASE_URL as string);
    url.pathname = `/${name}`;
    return {
      env: { ...base, BASTION_DATABASE_URL: url.toString() },
      cleanup: async () => {
        const a = new pg.Client({ connectionString: base.BASTION_DATABASE_URL });
        await a.connect();
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await a.end();
      },
    };
  };

  it('20.1 migrate applies every migration to an empty database and is a no-op the second time', async () => {
    const fresh = await freshEnv();
    try {
      const first = capture();
      expect(await execute(['migrate'], fresh.env, first.io)).toBe(0);
      expect(first.out.join('\n')).toMatch(/applied \d+ migration/);
      const second = capture();
      expect(await execute(['migrate'], fresh.env, second.io)).toBe(0);
      expect(second.out.join('\n')).toContain('up to date');
      const check = capture();
      expect(await execute(['check-config'], fresh.env, check.io)).toBe(0);
    } finally {
      await fresh.cleanup();
    }
  });

  it('20.1 check-config prints a table with ok rows and exits 1 on a failure', async () => {
    const good = capture();
    expect(await execute(['check-config'], env.env(), good.io)).toBe(0);
    const text = good.out.join('\n');
    expect(text).toMatch(/ok\s+postgres/);
    expect(text).toMatch(/ok\s+redis/);
    expect(text).toMatch(/ok\s+kms/);
    expect(text).toMatch(/ok\s+migrations/);

    const bad = capture();
    expect(
      await execute(
        ['check-config'],
        env.env({ BASTION_REDIS_URL: 'redis://127.0.0.1:1' }),
        bad.io,
      ),
    ).toBe(1);
    expect(bad.out.join('\n')).toMatch(/FAIL\s+redis/);

    const unmigrated = await freshEnv();
    try {
      const c = capture();
      expect(await execute(['check-config'], unmigrated.env, c.io)).toBe(1);
      expect(c.out.join('\n')).toMatch(/FAIL\s+migrations/);
    } finally {
      await unmigrated.cleanup();
    }

    const invalid = capture();
    expect(await execute(['check-config'], { BASTION_ROLE: 'nope' }, invalid.io)).toBe(1);
    expect(invalid.out.join('\n')).toContain('FAIL');
  });

  it('9.1 create-admin prints a generated password once; a second run creates nothing', async () => {
    const c = capture();
    expect(await execute(['create-admin', '--email', 'Root@Example.com'], env.env(), c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(
      /admin root@example.com created; password \(shown once\): \S{12,}/,
    );
    const again = capture();
    expect(
      await execute(['create-admin', '--email', 'root@example.com'], env.env(), again.io),
    ).toBe(1);
    expect(again.out.join('\n')).not.toMatch(/password/);
    const missing = capture();
    expect(await execute(['create-admin'], env.env(), missing.io)).toBe(2);
    const supplied = capture('a-long-enough-password\n');
    expect(
      await execute(
        ['create-admin', '--email', 'other@example.com', '--password-stdin'],
        env.env(),
        supplied.io,
      ),
    ).toBe(0);
    expect(supplied.out.join('\n')).not.toContain('a-long-enough-password');
  });

  it('22.3 rotate-keys rotates only when due, --force adds a key, a bad purpose exits 2', async () => {
    await seedDefaults(infra);
    const store = (infra.repos as unknown as { keyStore: import('@bastion-mcp/secrets').KeyStore })
      .keyStore;
    const none = capture();
    expect(await execute(['rotate-keys', '--purpose', 'as'], env.env(), none.io)).toBe(0);
    expect(none.out.join('\n')).toContain('no rotation due');
    expect(await store.listSigningKeys('as')).toHaveLength(1);
    const forced = capture();
    expect(await execute(['rotate-keys', '--purpose', 'as', '--force'], env.env(), forced.io)).toBe(
      0,
    );
    expect(forced.out.join('\n')).toContain('created key');
    expect(await store.listSigningKeys('as')).toHaveLength(2);
    const state = capture();
    expect(await execute(['rotate-keys', '--purpose=state', '--force'], env.env(), state.io)).toBe(
      0,
    );
    expect(await store.listStateKeys()).toHaveLength(2);
    const bad = capture();
    expect(await execute(['rotate-keys', '--purpose', 'nope'], env.env(), bad.io)).toBe(2);
  });

  it('20.1 set-role gives an account an organization role (an IdP user becomes an administrator), audited, and keeps the last administrator', async () => {
    const idp = await infra.repos.users.create({
      email: 'sso.user@example.com',
      displayName: 'Sso',
    });
    expect(idp.orgRole).toBe('member');

    const promote = capture();
    expect(
      await execute(
        ['set-role', '--email', 'SSO.User@example.com', '--role', 'admin'],
        env.env(),
        promote.io,
      ),
    ).toBe(0);
    expect(promote.out.join('\n')).toContain('sso.user@example.com is now admin (was member)');
    expect((await infra.repos.users.findByEmail('sso.user@example.com'))?.orgRole).toBe('admin');
    const audit = await infra.db.prisma.auditEvent.findFirst({
      where: { action: 'user.update', targetId: idp.id },
      orderBy: { seq: 'desc' },
    });
    expect(audit?.actorType).toBe('system');

    const again = capture();
    expect(
      await execute(
        ['set-role', '--email', 'sso.user@example.com', '--role', 'admin'],
        env.env(),
        again.io,
      ),
    ).toBe(0);
    expect(again.out.join('\n')).toContain('already is admin');

    // Wrong role, unknown account and a missing flag are refused with a reason.
    for (const [args, message] of [
      [
        ['set-role', '--email', 'sso.user@example.com', '--role', 'root'],
        /must be admin, auditor or member/,
      ],
      [
        ['set-role', '--email', 'nobody@example.com', '--role', 'admin'],
        /no account with the email/,
      ],
    ] as const) {
      const bad = capture();
      expect(await execute([...args], env.env(), bad.io)).toBe(1);
      expect(bad.err.join('\n')).toMatch(message);
    }
    const missing = capture();
    expect(
      await execute(['set-role', '--email', 'sso.user@example.com'], env.env(), missing.io),
    ).toBe(2);

    // Demoting the only administrator is refused. (Other tests of this file may have created administrators.)
    const admins = (
      await infra.repos.users.list({ orgRole: 'admin', status: 'active', limit: 200 })
    ).items;
    for (const a of admins.filter((x) => x.id !== idp.id)) {
      await infra.repos.users.update(a.id, { orgRole: 'member' }, { ifMatch: '*' });
    }
    const last = capture();
    expect(
      await execute(
        ['set-role', '--email', 'sso.user@example.com', '--role', 'member'],
        env.env(),
        last.io,
      ),
    ).toBe(1);
    expect(last.err.join('\n')).toContain('last active administrator');
  });

  it('20.1 export-config / import-config round trip is complete, idempotent and never carries a secret', async () => {
    const user = await infra.repos.users.create({ email: 'author@example.com', displayName: 'A' });
    const entry = await infra.repos.catalogEntries.create({
      slug: 'exported',
      displayName: 'Exported',
      description: 'for export',
      createdBy: user.id,
    });
    const version = await infra.repos.catalogVersions.create({
      entryId: entry.id,
      label: '1.0.0',
      serverSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: 'https://x.example.com/mcp',
        auth: { mode: 'none' },
      },
      installForm: {},
      createdBy: user.id,
    });
    await infra.repos.catalogVersions.publish(version.id);
    const secretValue = `S3CRET-${newId()}`;
    const secret = await infra.vault.put({
      scope: 'org',
      ownerId: null,
      name: 'registry-key',
      plaintext: secretValue,
    });
    await infra.db.prisma.registrySource.create({
      data: {
        id: newId(),
        name: 'Internal',
        baseUrl: 'https://registry.internal.example.com',
        trust: 'internal',
        authSecretId: secret.id,
        authHeaderName: 'X-Key',
      },
    });
    await infra.db.prisma.marketplace.create({
      data: {
        id: newId(),
        slug: 'mp',
        displayName: 'MP',
        audience: {},
        createdBy: user.id,
        mirror: {
          provider: 'github',
          url: 'https://github.com/a/b.git',
          credentialSecretId: secret.id,
        },
      },
    });
    await infra.repos.policyRules.create({
      name: 'forbid-x',
      effect: 'forbid',
      who: { all: true },
      what: { tool: 'x__*' },
      createdBy: user.id,
    } as never);

    const file = join(tmp, 'config.json');
    const ex = capture();
    expect(await execute(['export-config', '--out', file], env.env(), ex.io)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain(secret.id);
    expect(text).not.toMatch(
      /credentialSecretId|authSecretId|ciphertext|wrappedDek|localPasswordHash/,
    );
    const doc = JSON.parse(text);
    expect(doc.format).toBe(1);
    expect(doc.catalogEntries.map((e: { slug: string }) => e.slug)).toContain('exported');
    expect(doc.catalogVersions).toHaveLength(1);
    expect(doc.guardProfiles.length).toBeGreaterThanOrEqual(1);
    expect(doc.limitRules).toHaveLength(4);
    expect(doc.registrySources).toHaveLength(2);
    expect(doc.marketplaces[0].mirror).toEqual({
      provider: 'github',
      url: 'https://github.com/a/b.git',
    });
    expect(doc.policyRules).toHaveLength(1);

    const target = await freshEnv();
    try {
      expect(await execute(['migrate'], target.env, capture().io)).toBe(0);
      const dry = capture();
      expect(
        await execute(['import-config', '--file', file, '--dry-run'], target.env, dry.io),
      ).toBe(0);
      expect(dry.out.join('\n')).toContain('validated');
      const run = capture();
      expect(await execute(['import-config', '--file', file], target.env, run.io)).toBe(0);
      expect(run.out.join('\n')).toContain('imported');
      expect(await execute(['import-config', '--file', file], target.env, capture().io)).toBe(0);

      const out2 = join(tmp, 'config2.json');
      expect(await execute(['export-config', '--out', out2], target.env, capture().io)).toBe(0);
      const strip = (d: Record<string, unknown>) => ({ ...d, exportedAt: undefined });
      expect(strip(JSON.parse(readFileSync(out2, 'utf8')))).toEqual(strip(doc));

      const targetInfra = createInfra(loadConfig(target.env));
      try {
        const audit = await targetInfra.db.prisma.auditEvent.findMany({
          where: { action: 'config.import' },
        });
        expect(audit).toHaveLength(2);
      } finally {
        await targetInfra.close();
      }
    } finally {
      await target.cleanup();
    }
  });

  it('20.1 import-config rejects JSON that is not a format-1 export', async () => {
    const c = capture('{"hello":1}');
    expect(await execute(['import-config'], env.env(), c.io)).toBe(1);
    const bad = capture('not json');
    expect(await execute(['import-config'], env.env(), bad.io)).toBe(2);
  });
});

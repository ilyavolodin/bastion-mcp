import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, newId } from '@bastion-mcp/core';
import { verifyAuditRows } from '@bastion-mcp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, RestoreRefusedError, readBackup, restoreBackup } from '../src/backup/backup';
import { createMaintenance } from '../src/backup/maintenance';
import { BACKUP_TABLES, EXCLUDED_TABLES, isExcludedPartition } from '../src/backup/tables';
import { seedDefaults } from '../src/boot/seed';
import { execute } from '../src/cli';
import { createInfra, type Infra } from '../src/infra';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const PASS = 'a long enough passphrase';

type Instance = { env: TestEnv; infra: Infra };
const boot = async (): Promise<Instance> => {
  const env = await createTestEnv();
  const infra = createInfra(loadConfig(env.env()), { skipMigrationCheck: true });
  await seedDefaults(infra);
  return { env, infra };
};
const stop = async (i: Instance) => {
  await i.infra.close();
  await i.env.cleanup();
};

describe.skipIf(!haveDocker())('backup: the tables', () => {
  let a: Instance;
  beforeAll(async () => {
    a = await boot();
  });
  afterAll(() => stop(a));

  it('every table of the schema is either backed up or excluded, and the order satisfies foreign keys', async () => {
    const rows = await a.infra.db.prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );
    const known = new Set([...BACKUP_TABLES.map((t) => t.name), ...Object.keys(EXCLUDED_TABLES)]);
    const unclassified = rows
      .map((r) => r.table_name)
      .filter((t) => !known.has(t) && !isExcludedPartition(t));
    expect(unclassified, 'new tables must be added to BACKUP_TABLES or EXCLUDED_TABLES').toEqual(
      [],
    );
    const live = new Set(rows.map((r) => r.table_name));
    expect([...known].filter((t) => !live.has(t))).toEqual([]);

    const fks = await a.infra.db.prisma.$queryRawUnsafe<{ child: string; parent: string }[]>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    );
    const position = new Map(BACKUP_TABLES.map((t, i) => [t.name, i]));
    for (const { child, parent } of fks) {
      const c = position.get(child);
      const p = position.get(parent);
      if (c !== undefined && p !== undefined) {
        expect(p, `${parent} must come before ${child}`).toBeLessThanOrEqual(c);
      }
      // A backed-up table must not hang on an excluded one (a replace would cascade into it silently).
      if (p !== undefined && c === undefined) {
        const cascades = await a.infra.db.prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'
            AND conrelid = to_regclass($1) AND confrelid = to_regclass($2) AND confdeltype = 'c'`,
          child,
          parent,
        );
        expect(
          cascades[0]?.n,
          `${child} -> ${parent} must cascade or be backed up`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe.skipIf(!haveDocker())('backup and restore between two installations', () => {
  let a: Instance;
  let b: Instance;
  const adminId = newId();
  const memberId = newId();
  const teamId = newId();
  let file: Buffer;

  beforeAll(async () => {
    a = await boot();
    b = await boot();
    const db = a.infra.db.prisma;
    await db.user.createMany({
      data: [
        { id: adminId, email: 'admin@example.test', displayName: 'Admin', orgRole: 'admin' },
        { id: memberId, email: 'member@example.test', displayName: 'Member', orgRole: 'member' },
      ],
    });
    await db.team.create({ data: { id: teamId, slug: 'platform', displayName: 'Platform' } });
    await db.teamMembership.create({
      data: { teamId, userId: memberId, role: 'member', source: 'manual' },
    });
    await a.infra.secretStore.put(
      { scope: 'user', ownerId: memberId, name: 'hass-token' },
      'hunter2',
    );
    file = (await createBackup(a.infra, PASS, { id: adminId })).file;
  });
  afterAll(async () => {
    await stop(a);
    await stop(b);
  });

  it('the file holds no plaintext and needs the passphrase', async () => {
    expect(file.includes(Buffer.from('member@example.test'))).toBe(false);
    expect(file.includes(Buffer.from('hunter2'))).toBe(false);
    await expect(readBackup(file, 'not the passphrase!!')).rejects.toThrow(/wrong passphrase/);
  });

  it('a replace needs maintenance mode, and a dry run changes nothing', async () => {
    const maintenance = createMaintenance(b.infra.redis);
    await maintenance.set(false, 'test');
    const { document } = await readBackup(file, PASS);
    await expect(
      restoreBackup(b.infra, maintenance, document, { mode: 'replace', actorId: adminId }),
    ).rejects.toMatchObject({ code: 'maintenance_required' });
    const preview = await restoreBackup(b.infra, maintenance, document, {
      mode: 'replace',
      dryRun: true,
      actorId: adminId,
    });
    expect(preview.tables.users?.rows).toBe(2);
    expect(await b.infra.db.prisma.user.count()).toBe(0);
  });

  it('a replace restores users, teams, secrets (under the target KMS), keys and a verifiable audit chain', async () => {
    const maintenance = createMaintenance(b.infra.redis);
    await maintenance.set(true, 'test');
    const { document } = await readBackup(file, PASS);
    const report = await restoreBackup(b.infra, maintenance, document, {
      mode: 'replace',
      actorId: adminId,
    });
    expect(report.tables.users?.rows).toBe(2);

    const db = b.infra.db.prisma;
    expect((await db.user.findMany({ orderBy: { email: 'asc' } })).map((u) => u.email)).toEqual([
      'admin@example.test',
      'member@example.test',
    ]);
    expect(await db.teamMembership.count()).toBe(1);
    // Different KMS key on each instance: the value only opens if the data key was re-wrapped.
    expect(a.env.dataDir).not.toBe(b.env.dataDir);
    expect(
      await b.infra.secretStore.reveal({ scope: 'user', ownerId: memberId, name: 'hass-token' }),
    ).toBe('hunter2');
    expect((await db.signingKey.findMany()).map((k) => k.kid).sort()).toEqual(
      (await a.infra.db.prisma.signingKey.findMany()).map((k) => k.kid).sort(),
    );

    const audit = await db.auditEvent.findMany({ orderBy: { seq: 'asc' } });
    expect(audit.at(-1)?.action).toBe('backup.restore.replace');
    expect(
      verifyAuditRows(
        audit.map((r) => ({
          ...r,
          prevHash: r.prevHash ? Buffer.from(r.prevHash) : null,
          hash: Buffer.from(r.hash),
        })) as never,
      ).ok,
    ).toBe(true);
    // The sequence continues after the restored rows.
    await db.$transaction(async (tx) => {
      const { appendAuditEvent } = await import('@bastion-mcp/db');
      await appendAuditEvent(tx, { actorType: 'system', action: 'test.after', targetType: 'test' });
    });
  });

  it('a replace refuses a backup that would lock everybody out or remove the acting admin', async () => {
    const maintenance = createMaintenance(b.infra.redis);
    await maintenance.set(true, 'test');
    const { document } = await readBackup(file, PASS);
    await expect(
      restoreBackup(b.infra, maintenance, document, { mode: 'replace', actorId: memberId }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    const noAdmin = {
      ...document,
      tables: {
        ...document.tables,
        users: document.tables.users?.map((u) => ({ ...u, org_role: 'member' })) ?? [],
      },
    };
    await expect(
      restoreBackup(b.infra, maintenance, noAdmin, { mode: 'replace' }),
    ).rejects.toBeInstanceOf(RestoreRefusedError);
  });

  it("a merge overwrites matching rows, adds missing ones, keeps this installation's own keys and skips the audit log", async () => {
    const db = b.infra.db.prisma;
    await db.user.update({ where: { id: memberId }, data: { displayName: 'Changed locally' } });
    const strangerId = newId();
    await db.user.create({
      data: {
        id: strangerId,
        email: 'local@example.test',
        displayName: 'Local',
        orgRole: 'member',
      },
    });
    const keysBefore = (await db.signingKey.findMany()).map((k) => k.kid).sort();
    const auditBefore = await db.auditEvent.count();

    const maintenance = createMaintenance(b.infra.redis);
    await maintenance.set(false, 'test');
    const { document } = await readBackup(file, PASS);
    const preview = await restoreBackup(b.infra, maintenance, document, {
      mode: 'merge',
      dryRun: true,
    });
    expect(preview.tables.users).toMatchObject({ rows: 2, existing: 2 });
    expect(preview.tables.signing_keys?.action).toBe('skip');

    await restoreBackup(b.infra, maintenance, document, { mode: 'merge', actorId: adminId });
    expect((await db.user.findUnique({ where: { id: memberId } }))?.displayName).toBe('Member');
    // Nothing is deleted by a merge.
    expect(await db.user.findUnique({ where: { id: strangerId } })).not.toBeNull();
    expect((await db.signingKey.findMany()).map((k) => k.kid).sort()).toEqual(keysBefore);
    // Only the restore's own audit event is added.
    expect(await db.auditEvent.count()).toBe(auditBefore + 1);
  });

  it('refuses a backup made under a newer schema', async () => {
    const maintenance = createMaintenance(b.infra.redis);
    const { document } = await readBackup(file, PASS);
    await expect(
      restoreBackup(
        b.infra,
        maintenance,
        { ...document, migration: '9999_future' },
        { mode: 'merge' },
      ),
    ).rejects.toMatchObject({ code: 'newer_schema' });
  });
});

describe.skipIf(!haveDocker())('backup commands of the CLI', () => {
  let a: Instance;
  let dir: string;
  beforeAll(async () => {
    a = await boot();
    dir = mkdtempSync(join(tmpdir(), 'bastion-bk-'));
    await a.infra.db.prisma.user.create({
      data: { id: newId(), email: 'root@example.test', displayName: 'Root', orgRole: 'admin' },
    });
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await stop(a);
  });

  const run = async (argv: string[], stdin = '', extra: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await execute(argv, a.env.env({ BASTION_BACKUP_PASSPHRASE: PASS, ...extra }), {
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      stdin: async () => stdin,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('backs up to a file, previews a restore and refuses a replace outside maintenance mode', async () => {
    const file = join(dir, 'b.bastion-backup');
    const made = await run(['backup', '--out', file]);
    expect(made.code).toBe(0);
    expect(made.out).toContain('backup written');
    expect(readFileSync(file).length).toBeGreaterThan(100);

    const preview = await run(['restore', '--file', file, '--dry-run']);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('would restore (merge)');
    expect(preview.out).toContain('signing_keys');

    expect((await run(['maintenance', 'off'])).out).toContain('off');
    const refused = await run(['restore', '--file', file, '--mode', 'replace']);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/maintenance/);

    expect((await run(['maintenance', 'on'])).out).toContain('ON');
    expect((await run(['maintenance', 'status'])).out).toContain('ON');
    const replaced = await run(['restore', '--file', file, '--mode', 'replace']);
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain('restored (replace)');
    expect(replaced.out).toContain('bastion maintenance off');
    expect(await a.infra.db.prisma.user.count()).toBe(1);
    await run(['maintenance', 'off']);
  });

  it('needs a passphrase, a wrong one fails, and the passphrase can come from stdin', async () => {
    const file = join(dir, 'c.bastion-backup');
    const none = await run(['backup', '--out', file], '', { BASTION_BACKUP_PASSPHRASE: '' });
    expect(none.code).toBe(2);
    const piped = await run(['backup', '--out', file, '--passphrase-stdin'], 'from stdin pass\n', {
      BASTION_BACKUP_PASSPHRASE: '',
    });
    expect(piped.code).toBe(0);
    const wrong = await run(['restore', '--file', file, '--dry-run'], '', {
      BASTION_BACKUP_PASSPHRASE: 'a different passphrase',
    });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/wrong passphrase/);
  });
});

import { loadConfig, newId, REDIS_CHANNELS } from '@bastion-mcp/core';
import { NIL_UUID } from '@bastion-mcp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, RestoreRefusedError, readBackup, restoreBackup } from '../src/backup/backup';
import { createMaintenance } from '../src/backup/maintenance';
import { BACKUP_TABLES } from '../src/backup/tables';
import { seedDefaults } from '../src/boot/seed';
import { createInfra, type Infra } from '../src/infra';
import { BACKUP_TX_OPTIONS } from '../src/timing';
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

type Publication = { channel: string; message: unknown };
type Observed = {
  infra: Infra;
  published: Publication[];
  /** SQL of the raw statements run inside the transaction, in order. */
  statements: string[];
  /** Options handed to `$transaction`, one entry per call. */
  txOptions: unknown[];
  /** Calls that happened outside of the transaction callback while it was open: none expected. */
  userCountAtFirstPublish: number[];
};

/** The same installation with `publish` and `$transaction` recorded; everything is passed through. */
const observe = (infra: Infra): Observed => {
  const published: Publication[] = [];
  const statements: string[] = [];
  const txOptions: unknown[] = [];
  const userCountAtFirstPublish: number[] = [];
  const prisma = infra.db.prisma;
  const wrappedPrisma = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
          txOptions.push(options);
          return target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    const value = Reflect.get(t, p, r);
                    if (p === '$executeRawUnsafe') {
                      return (sql: string, ...rest: unknown[]) => {
                        statements.push(sql);
                        return (value as (...a: unknown[]) => unknown).call(t, sql, ...rest);
                      };
                    }
                    return typeof value === 'function' ? value.bind(t) : value;
                  },
                }),
              ),
            options as never,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapped = {
    ...infra,
    db: { ...infra.db, prisma: wrappedPrisma },
    publish: async (channel: string, message: unknown) => {
      if (published.length === 0) userCountAtFirstPublish.push(await prisma.user.count());
      published.push({ channel, message });
      await infra.publish(channel, message);
    },
  } as Infra;
  return { infra: wrapped, published, statements, txOptions, userCountAtFirstPublish };
};

const kinds = (statements: string[]): string[] =>
  statements.map((s) => {
    const del = /^DELETE FROM "?([a-z_]+)"?$/.exec(s);
    if (del) return `delete ${del[1]}`;
    const ins = /^INSERT INTO "?([a-z_]+)"? /.exec(s);
    if (ins) return `insert ${ins[1]}`;
    if (s.startsWith('SELECT setval')) return 'setval';
    return `other ${s.slice(0, 40)}`;
  });

describe.skipIf(!haveDocker())('restoreBackup characterization (SV-17)', () => {
  let a: Instance;
  let b: Instance;
  const adminId = newId();
  const memberId = newId();
  const teamId = newId();
  const entryA = newId();
  const entryB = newId();
  let file: Buffer;

  const counts = async (i: Instance) => {
    const db = i.infra.db.prisma;
    return {
      users: await db.user.count(),
      teams: await db.team.count(),
      memberships: await db.teamMembership.count(),
      audit: await db.auditEvent.count(),
      signingKeys: await db.signingKey.count(),
    };
  };
  const maintenanceOn = async (i: Instance, on: boolean) => {
    const m = createMaintenance(i.infra.redis);
    await m.set(on, 'test');
    return m;
  };

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
    for (const [id, slug] of [
      [entryA, 'entry-a'],
      [entryB, 'entry-b'],
    ] as const) {
      await db.catalogEntry.create({
        data: {
          id,
          slug,
          displayName: slug,
          description: 'd',
          visibility: { kind: 'all' },
          source: { kind: 'custom' },
          createdBy: adminId,
        },
      });
    }
    await a.infra.secretStore.put({ scope: 'user', ownerId: memberId, name: 'tok' }, 'hunter2');
    file = (await createBackup(a.infra, PASS, { id: adminId })).file;
  });
  afterAll(async () => {
    await stop(a);
    await stop(b);
  });

  it('6.1 refusals are checked in order: newer schema, then unsafe replace, then maintenance', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const noAdmin = {
      ...document,
      tables: {
        ...document.tables,
        users: (document.tables.users ?? []).map((u) => ({ ...u, org_role: 'member' })),
      },
    };
    // Newer schema wins over both of the others.
    await expect(
      restoreBackup(b.infra, m, { ...noAdmin, migration: '9999_future' }, { mode: 'replace' }),
    ).rejects.toMatchObject({ code: 'newer_schema' });
    // Unsafe wins over "maintenance is off", and applies to a dry run too.
    await expect(restoreBackup(b.infra, m, noAdmin, { mode: 'replace' })).rejects.toMatchObject({
      code: 'unsafe',
    });
    await expect(
      restoreBackup(b.infra, m, noAdmin, { mode: 'replace', dryRun: true }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    // A merge needs neither the administrator nor maintenance mode.
    await expect(
      restoreBackup(b.infra, m, noAdmin, { mode: 'merge', dryRun: true }),
    ).resolves.toMatchObject({
      mode: 'merge',
    });
    expect(await counts(b)).toMatchObject({ users: 0, teams: 0 });
  });

  it('6.2 a dry run reports per table, writes nothing and publishes nothing', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const obs = observe(b.infra);
    const before = await counts(b);
    const report = await restoreBackup(obs.infra, m, document, { mode: 'merge', dryRun: true });
    expect(await counts(b)).toEqual(before);
    expect(obs.published).toEqual([]);
    expect(obs.statements).toEqual([]);
    expect(obs.txOptions).toEqual([]);

    expect(report.dryRun).toBe(true);
    expect(report.backup).toEqual({
      createdAt: document.createdAt,
      migration: document.migration,
    });
    // One entry per backup table, in table order.
    expect(Object.keys(report.tables)).toEqual(BACKUP_TABLES.map((t) => t.name));
    expect(report.tables.users).toEqual({ rows: 2, existing: 0, action: 'restore' });
    expect(report.tables.signing_keys).toMatchObject({
      rows: 0,
      existing: 0,
      action: 'skip',
    });
    expect(report.tables.audit_events).toMatchObject({ rows: 0, action: 'skip' });
    // The note of a skipped table is the skip reason, unless the table is also missing from the backup.
    const skipped = BACKUP_TABLES.filter((t) => t.restore === 'replace').map((t) => t.name);
    for (const name of skipped) {
      const present = name in document.tables;
      expect(report.tables[name]?.note).toBe(
        present ? 'restored by a replace only' : 'not in this backup',
      );
    }
    // Every "not in this backup" note has exactly one warning, in table order.
    const missing = BACKUP_TABLES.filter((t) => !(t.name in document.tables)).map((t) => t.name);
    expect(report.warnings.filter((w) => w.endsWith('is not in this backup'))).toEqual(
      missing.map((n) => `${n} is not in this backup`),
    );
  });

  it('6.3 a dry run replace counts what the target has now and needs no maintenance mode', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const report = await restoreBackup(b.infra, m, document, {
      mode: 'replace',
      dryRun: true,
      actorId: adminId,
    });
    expect(report.mode).toBe('replace');
    expect(report.tables.users).toMatchObject({ rows: 2, existing: 0, action: 'restore' });
    expect(report.tables.signing_keys).toMatchObject({ action: 'restore' });
    expect(report.tables.signing_keys?.existing).toBe(await b.infra.db.prisma.signingKey.count());
    expect(report.tables.audit_events?.existing).toBe(await b.infra.db.prisma.auditEvent.count());
    // Skipped tables report 0 rows and a replace skips nothing.
    expect(Object.values(report.tables).filter((t) => t.action === 'skip')).toEqual([]);
  });

  it('6.4 a replace that fails part way rolls back the deletes, publishes nothing and refuses as a conflict', async () => {
    const m = await maintenanceOn(b, true);
    const { document } = await readBackup(file, PASS);
    // A membership that points at a user which is not in the backup: the foreign key fails after the deletes ran.
    const bad = {
      ...document,
      tables: {
        ...document.tables,
        team_memberships: [
          ...(document.tables.team_memberships ?? []),
          { team_id: teamId, user_id: newId(), role: 'member', source: 'manual' },
        ],
      },
    };
    // Give the target something to lose.
    const localId = newId();
    await b.infra.db.prisma.user.create({
      data: { id: localId, email: 'local@example.test', displayName: 'Local', orgRole: 'admin' },
    });
    const before = await counts(b);
    const obs = observe(b.infra);
    const failure = await restoreBackup(obs.infra, m, bad, {
      mode: 'replace',
      actorId: adminId,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(RestoreRefusedError);
    expect(failure).toMatchObject({ code: 'conflict' });
    expect((failure as Error).message).toMatch(/^team_memberships: /);
    // The transaction ran the deletes and the inserts up to the failing table, then rolled back.
    const ran = kinds(obs.statements);
    expect(ran.slice(0, 3)).toEqual(
      [...BACKUP_TABLES]
        .reverse()
        .slice(0, 3)
        .map((t) => `delete ${t.name}`),
    );
    expect(ran).toContain('insert users');
    expect(ran).toContain('insert team_memberships');
    expect(ran).not.toContain('setval');
    expect(await counts(b)).toEqual(before);
    expect(await b.infra.db.prisma.user.findUnique({ where: { id: localId } })).not.toBeNull();
    expect(obs.published).toEqual([]);
    await b.infra.db.prisma.user.delete({ where: { id: localId } });
  });

  it('6.5 a merge that fails part way rolls back what it wrote', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const bad = {
      ...document,
      tables: {
        ...document.tables,
        team_memberships: [
          ...(document.tables.team_memberships ?? []),
          { team_id: teamId, user_id: newId(), role: 'member', source: 'manual' },
        ],
      },
    };
    const before = await counts(b);
    const obs = observe(b.infra);
    await expect(restoreBackup(obs.infra, m, bad, { mode: 'merge' })).rejects.toMatchObject({
      code: 'conflict',
    });
    // Users went in before the failure and were rolled back.
    expect(kinds(obs.statements)).toContain('insert users');
    expect(await counts(b)).toEqual(before);
    expect(obs.published).toEqual([]);
  });

  it('6.6 a secret without a data key is refused before the transaction starts', async () => {
    const m = await maintenanceOn(b, true);
    const { document } = await readBackup(file, PASS);
    const secrets = (document.tables.secrets ?? []).map((r) => {
      const { dek: _dek, ...rest } = r;
      return rest;
    });
    expect(secrets.length).toBeGreaterThan(0);
    const bad = { ...document, tables: { ...document.tables, secrets } };
    const before = await counts(b);
    const obs = observe(b.infra);
    const failure = await restoreBackup(obs.infra, m, bad, {
      mode: 'replace',
      actorId: adminId,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(RestoreRefusedError);
    expect(failure).toMatchObject({ code: 'invalid' });
    expect((failure as Error).message).toMatch(/^secret .+ has no data key$/);
    expect(obs.statements).toEqual([]);
    expect(obs.txOptions).toEqual([]);
    expect(obs.published).toEqual([]);
    expect(await counts(b)).toEqual(before);
  });

  it('6.7 a replace runs deletes in reverse table order, inserts in table order, then the sequence, in one transaction', async () => {
    const m = await maintenanceOn(b, true);
    const { document } = await readBackup(file, PASS);
    const obs = observe(b.infra);
    await restoreBackup(obs.infra, m, document, { mode: 'replace', actorId: adminId });

    expect(obs.txOptions).toEqual([BACKUP_TX_OPTIONS]);
    const ran = kinds(obs.statements);
    const names = BACKUP_TABLES.map((t) => t.name);
    const n = names.length;
    expect(ran.slice(0, n)).toEqual([...names].reverse().map((t) => `delete ${t}`));
    const inserts = ran.slice(n, -1);
    expect(inserts.every((s) => s.startsWith('insert '))).toBe(true);
    // Inserted tables appear in table order (empty tables are skipped).
    const order = inserts.map((s) => names.indexOf(s.slice('insert '.length)));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(new Set(order).size).toBe(order.length);
    expect(inserts).toContain('insert users');
    expect(inserts).toContain('insert audit_events');
    expect(inserts).toContain('insert signing_keys');
    expect(ran.at(-1)).toBe('setval');
  });

  it('6.8 a replace publishes after the commit: org, each catalog entry in backup order, then signing and state keys', async () => {
    const m = await maintenanceOn(b, true);
    const { document } = await readBackup(file, PASS);
    const obs = observe(b.infra);
    await restoreBackup(obs.infra, m, document, { mode: 'replace', actorId: adminId });

    // The data was already committed and visible when the first message went out.
    expect(obs.userCountAtFirstPublish).toEqual([2]);
    const ids = (document.tables.catalog_entries ?? []).map((e) => String(e.id));
    expect(ids.slice().sort()).toEqual([entryA, entryB].sort());
    const messages = obs.published.map((p) => {
      const msg = typeof p.message === 'string' ? JSON.parse(p.message) : p.message;
      return { channel: p.channel, msg };
    });
    expect(messages.every((x) => x.channel === REDIS_CHANNELS.config)).toBe(true);
    expect(messages.map((x) => [x.msg.topic, x.msg.scope, x.msg.id, 'version' in x.msg])).toEqual([
      ['org', 'org', NIL_UUID, true],
      ...ids.map((id) => ['catalog', 'catalog', id, true]),
      ['signing_keys', 'signing_keys', NIL_UUID, false],
      ['state_keys', 'state_keys', NIL_UUID, false],
    ]);
    // The two key messages are plain objects, not JSON strings.
    expect(obs.published.slice(-2).map((p) => typeof p.message)).toEqual(['object', 'object']);
    expect(obs.published.slice(0, -2).every((p) => typeof p.message === 'string')).toBe(true);
  });

  it('6.9 the restore audit event carries the actor, the mode and per-table row counts', async () => {
    const m = await maintenanceOn(b, true);
    const { document } = await readBackup(file, PASS);
    const report = await restoreBackup(b.infra, m, document, {
      mode: 'replace',
      actorId: adminId,
    });
    const last = await b.infra.db.prisma.auditEvent.findFirst({ orderBy: { seq: 'desc' } });
    expect(last).toMatchObject({
      actorType: 'user',
      actorId: adminId,
      action: 'backup.restore.replace',
      targetType: 'backup',
    });
    expect(last?.diff).toEqual({
      backupCreatedAt: document.createdAt,
      counts: Object.fromEntries(Object.entries(report.tables).map(([k, v]) => [k, v.rows])),
    });
    // The replace brought the sequence back in step with the restored rows.
    const max = await b.infra.db.prisma.auditEvent.aggregate({ _max: { seq: true } });
    expect(max._max.seq).toBe(last?.seq);
  });

  it('6.10 a merge publishes org and catalog only, audits as the system without an actor, and keeps the target audit log', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const obs = observe(b.infra);
    const auditBefore = await b.infra.db.prisma.auditEvent.count();
    const report = await restoreBackup(obs.infra, m, document, { mode: 'merge' });

    const ids = (document.tables.catalog_entries ?? []).map((e) => String(e.id));
    const topics = obs.published.map((p) => {
      const msg = typeof p.message === 'string' ? JSON.parse(p.message) : p.message;
      return [msg.topic, msg.id];
    });
    expect(topics).toEqual([['org', NIL_UUID], ...ids.map((id) => ['catalog', id])]);

    const ran = kinds(obs.statements);
    expect(ran.some((s) => s.startsWith('delete '))).toBe(false);
    expect(ran).not.toContain('setval');
    expect(ran).not.toContain('insert signing_keys');
    expect(ran).not.toContain('insert audit_events');
    expect(report.tables.signing_keys?.action).toBe('skip');

    expect(await b.infra.db.prisma.auditEvent.count()).toBe(auditBefore + 1);
    const last = await b.infra.db.prisma.auditEvent.findFirst({ orderBy: { seq: 'desc' } });
    expect(last).toMatchObject({
      actorType: 'system',
      actorId: null,
      action: 'backup.restore.merge',
    });
  });

  it('6.11 a merge refuses, even as a dry run, to replace the acting account, and the refusal comes before any write', async () => {
    const m = await maintenanceOn(b, false);
    const { document } = await readBackup(file, PASS);
    const localAdmin = newId();
    // Same email as the backup's admin, other id: the backup would replace the acting account.
    await b.infra.db.prisma.user.update({
      where: { id: adminId },
      data: { email: 'moved@example.test' },
    });
    await b.infra.db.prisma.user.create({
      data: {
        id: localAdmin,
        email: 'admin@example.test',
        displayName: 'Local admin',
        orgRole: 'admin',
      },
    });
    const obs = observe(b.infra);
    const before = await counts(b);
    await expect(
      restoreBackup(obs.infra, m, document, { mode: 'merge', dryRun: true, actorId: localAdmin }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    await expect(
      restoreBackup(obs.infra, m, document, { mode: 'merge', actorId: localAdmin }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    expect(obs.statements).toEqual([]);
    expect(obs.published).toEqual([]);
    expect(await counts(b)).toEqual(before);
    // Another actor gets a warning in the report instead.
    const report = await restoreBackup(obs.infra, m, document, { mode: 'merge', dryRun: true });
    expect(report.warnings).toContain(
      'users: 1 existing row shares email with a row of the backup and is replaced by it (the backup wins)',
    );
  });
});

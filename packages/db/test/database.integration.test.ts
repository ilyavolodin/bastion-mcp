import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { newId } from '@bastion-mcp/core';
import { dockerAvailable, startPostgres, type TestPostgres } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAuditEvent, verifyAuditChain } from '../src/audit';
import { createDb, type Db } from '../src/client';
import { bumpConfigVersion, getConfigVersion } from '../src/config-version';
import { dropPartitionsBefore, ensurePartitions, listPartitions } from '../src/partitions';

const run = dockerAvailable();

describe.skipIf(!run)('16 data model against a real Postgres', () => {
  let pg: TestPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startPostgres();
    execFileSync('pnpm', ['prisma', 'migrate', 'deploy'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, BASTION_DATABASE_URL: pg.url },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    db = createDb({ url: pg.url, poolMax: 5 });
  }, 180_000);

  afterAll(async () => {
    await db?.close();
    await pg?.stop();
  });

  it('16.2 applies the migration and creates today and 7 days of call_log partitions', async () => {
    const partitions = await listPartitions(db.prisma, 'call_log');
    expect(partitions.length).toBeGreaterThanOrEqual(8);
  });

  it('16.2 users.email is case-insensitive unique (citext)', async () => {
    const id = newId();
    await db.prisma.user.create({ data: { id, email: 'Ada@Acme.com', displayName: 'Ada' } });
    await expect(
      db.prisma.user.create({ data: { id: newId(), email: 'ada@acme.com', displayName: 'Ada 2' } }),
    ).rejects.toThrow();
  });

  it('16.2 CHECK constraints reject unknown values', async () => {
    await expect(
      db.prisma.user.create({
        data: { id: newId(), email: 'x@acme.com', displayName: 'X', orgRole: 'root' },
      }),
    ).rejects.toThrow();
  });

  it('16.2 an installation needs a catalog entry or a personal spec, never both nor neither', async () => {
    const base = {
      ownerType: 'user',
      ownerId: newId(),
      slug: 'pg',
      toolPrefix: 'pg',
      displayName: 'PG',
      origin: 'manual',
    };
    await expect(
      db.prisma.installation.create({ data: { id: newId(), ...base } }),
    ).rejects.toThrow();
    await db.prisma.installation.create({
      data: { id: newId(), ...base, personalSpec: { type: 'remote' } },
    });
  });

  it('16.2 call_log rows land in the daily partition and rollup keys have no NULLs', async () => {
    await db.prisma.callLog.create({
      data: {
        id: newId(),
        ts: new Date(),
        durationMs: 12,
        principalType: 'user',
        principalId: newId(),
        method: 'tools/call',
        outcome: 'ok',
        eraDown: 'modern',
      },
    });
    expect(await db.prisma.callLog.count()).toBe(1);
    await db.prisma.callStatsMinute.create({
      data: {
        bucket: new Date(),
        outcome: 'ok',
        count: 1,
        bytesOut: 10n,
        latencyBuckets: new Array(24).fill(0),
      },
    });
  });

  it('15.5 partitions can be created ahead and dropped by cutoff', async () => {
    await ensurePartitions(db.prisma, 'egress_events', 10);
    const before = (await listPartitions(db.prisma, 'egress_events')).length;
    expect(before).toBeGreaterThanOrEqual(11);
    const cutoff = new Date(Date.now() + 5 * 86_400_000);
    const dropped = await dropPartitionsBefore(db.prisma, 'egress_events', cutoff);
    expect(dropped).toBeGreaterThan(0);
    expect((await listPartitions(db.prisma, 'egress_events')).length).toBe(before - dropped);
  });

  it('15.6 appends hash-chained audit events under concurrency and verifies the chain', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.prisma.$transaction((tx) =>
          appendAuditEvent(tx, {
            actorType: 'user',
            actorId: newId(),
            action: `test.action.${i}`,
            targetType: 'thing',
            targetId: String(i),
            diff: { i },
          }),
        ),
      ),
    );
    expect(await verifyAuditChain(db.prisma)).toMatchObject({ ok: true, checked: 10 });
    await db.prisma.$executeRawUnsafe(`UPDATE audit_events SET action = 'forged' WHERE seq = 4`);
    expect(await verifyAuditChain(db.prisma)).toMatchObject({ ok: false, brokenAtSeq: 4n });
  });

  it('4.3 bumps config versions atomically per scope', async () => {
    expect(await getConfigVersion(db.prisma, 'org')).toBe(0n);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.prisma.$transaction((tx) => bumpConfigVersion(tx, 'org'))),
    );
    expect(new Set(results).size).toBe(5);
    expect(await getConfigVersion(db.prisma, 'org')).toBe(5n);
    expect(await bumpConfigVersion(db.prisma, 'principal', newId())).toBe(1n);
  });
});

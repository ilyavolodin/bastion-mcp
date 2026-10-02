import { createHash } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { appendAuditEvent, verifyAuditChain } from '../../src/audit';
import { bumpConfigVersion, getConfigVersion } from '../../src/config-version';
import {
  type ConfigEvent,
  createAuditLogRepository,
  createEgressAccessRequestRepository,
  createInstallationRepository,
  createInstanceRepository,
  createRepositories,
  createSnapshotStore,
  createTeamRepository,
  createUserRepository,
  type InstanceRecord,
  instanceState,
  SNAPSHOTS_KEPT,
  withTransaction,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const audit = {
  actorType: 'user',
  actorId: newId(),
  ip: '10.0.0.7',
  userAgent: 'vitest',
  requestId: 'req-9',
} as const;
const hex = (v: string) => createHash('sha256').update(v).digest('hex');

describe('8.6 instance state', () => {
  it.each([
    [{ startedAt: undefined, error: undefined }, 'starting'],
    [{ startedAt: 1, error: undefined }, 'running'],
    [{ startedAt: 1, error: { phase: 'p', message: 'm', stderrTail: [], at: 1 } }, 'failed'],
  ])('%j is %s', (rec, state) => {
    expect(instanceState(rec)).toBe(state);
  });
});

describe.skipIf(!dbEnabled())(
  '15.6, 8.6, 7.5, 17.1 audit log, instances, snapshots and the unit of work',
  () => {
    const h = useTestDb();

    const seedInstallation = async () => {
      const user = await createUserRepository(h.db.prisma).create({
        email: `i${newId()}@acme.com`,
        displayName: 'I',
      });
      const inst = await createInstallationRepository(h.db.prisma).create({
        ownerType: 'user',
        ownerId: user.id,
        personalSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: 'https://x.example',
          auth: { mode: 'none' },
        },
        slug: `s${newId().slice(-8)}`,
        displayName: 'S',
      });
      return { user, inst };
    };

    describe('15.6 audit log', () => {
      it('lists newest first with filters, prefix actions and seq cursors; exports oldest first in batches', async () => {
        const log = createAuditLogRepository(h.db.prisma);
        const actor = newId();
        await h.db.prisma.$transaction(async (tx) => {
          for (let i = 0; i < 7; i++) {
            await appendAuditEvent(tx, {
              actorType: 'user',
              actorId: actor,
              action: i % 2 ? 'catalog.publish' : 'team.create',
              targetType: i % 2 ? 'catalog_entry' : 'team',
              targetId: `t${i}`,
              diff: { i },
              ip: '10.0.0.1',
              userAgent: 'ua',
              requestId: 'r1',
            });
          }
        });
        const all = await log.list({ actorId: actor, limit: 3 });
        expect(all.items.map((e) => e.targetId)).toEqual(['t6', 't5', 't4']);
        expect(all.items[0]).toMatchObject({
          hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          ip: '10.0.0.1',
          requestId: 'r1',
        });
        const page2 = await log.list({
          actorId: actor,
          limit: 3,
          cursor: all.nextCursor ?? undefined,
        });
        expect(page2.items.map((e) => e.targetId)).toEqual(['t3', 't2', 't1']);
        const page3 = await log.list({
          actorId: actor,
          limit: 3,
          cursor: page2.nextCursor ?? undefined,
        });
        expect(page3.items.map((e) => e.targetId)).toEqual(['t0']);
        expect(page3.nextCursor).toBeNull();
        expect((await log.list({ actorId: actor, action: 'catalog.*' })).items).toHaveLength(3);
        expect(
          (
            await log.list({
              actorId: actor,
              action: 'team.create',
              targetType: 'team',
              targetId: 't2',
            })
          ).items,
        ).toHaveLength(1);
        expect(
          (
            await log.list({
              actorType: 'user',
              requestId: 'r1',
              actorId: actor,
              from: new Date(Date.now() - 60_000),
              to: new Date(Date.now() + 60_000),
            })
          ).items,
        ).toHaveLength(7);
        expect(
          (await log.list({ actorId: actor, from: new Date(Date.now() + 60_000) })).items,
        ).toEqual([]);
        await expect(log.list({ cursor: 'x!' })).rejects.toMatchObject({ httpStatus: 400 });
        await expect(
          log.list({ cursor: Buffer.from('["abc"]').toString('base64url') }),
        ).rejects.toMatchObject({ httpStatus: 400 });
        expect((await log.get(all.items[0]?.id ?? ''))?.targetId).toBe('t6');
        expect(await log.get(newId())).toBeNull();

        const batches: number[] = [];
        const seqs: bigint[] = [];
        for await (const batch of log.export({ actorId: actor }, 3)) {
          batches.push(batch.length);
          seqs.push(...batch.map((e) => e.seq));
        }
        expect(batches).toEqual([3, 3, 1]);
        expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));
        const exact: number[] = [];
        for await (const batch of log.export({ actorId: actor }, 7)) exact.push(batch.length);
        expect(exact).toEqual([7]);
        const none: number[] = [];
        for await (const batch of log.export({ actorId: newId() })) none.push(batch.length);
        expect(none).toEqual([]);
      });

      it('verifies the chain, detects tampering and keeps verifying after the oldest prefix is pruned', async () => {
        const log = createAuditLogRepository(h.db.prisma);
        const before = await log.verify();
        expect(before.ok).toBe(true);
        const cutoff = new Date();
        await new Promise((r) => setTimeout(r, 20));
        await h.db.prisma.$transaction(async (tx) => {
          for (let i = 0; i < 3; i++)
            await appendAuditEvent(tx, {
              actorType: 'system',
              action: 'late',
              targetType: 't',
              targetId: String(i),
            });
        });
        const removed = await log.pruneBefore(cutoff);
        expect(removed).toBeGreaterThan(0);
        const after = await log.verify();
        expect(after).toMatchObject({ ok: true, checked: 3 });
        expect(await log.pruneBefore(new Date(0))).toBe(0);
      });
    });

    describe('17.1 unit of work', () => {
      it('commits repository writes, config bumps and audit events together, publishing only after commit', async () => {
        const events: ConfigEvent[] = [];
        const order: string[] = [];
        let publishedBeforeCommit = false;
        const result = await withTransaction(
          h.db.prisma,
          async ({ repos, afterCommit, tx }) => {
            const user = await repos.users.create(
              { email: 'uow@acme.com', displayName: 'U' },
              { audit },
            );
            const team = await repos.teams.create(
              { slug: 'uow-team', displayName: 'T' },
              { audit },
            );
            await repos.teams.setMembership(
              { teamId: team.id, userId: user.id, role: 'manager' },
              { audit },
            );
            afterCommit(() => void order.push('hook'));
            // nothing is visible outside the transaction yet, and nothing was published
            publishedBeforeCommit =
              events.length > 0 ||
              (await h.db.prisma.user.count({ where: { email: 'uow@acme.com' } })) > 0;
            expect(await tx.user.count({ where: { email: 'uow@acme.com' } })).toBe(1);
            return { user, team };
          },
          {
            publishConfig: (e) => {
              events.push(e);
              order.push('publish');
            },
          },
        );
        expect(publishedBeforeCommit).toBe(false);
        expect(order).toEqual(['publish', 'publish', 'hook']);
        expect(events.map((e) => e.scope).sort()).toEqual(['team', 'user']);
        const teamEvent = events.find((e) => e.scope === 'team');
        expect(teamEvent).toMatchObject({ id: result.team.id });
        expect(teamEvent?.version).toBe(
          await getConfigVersion(h.db.prisma, 'team', result.team.id),
        );
        expect(
          await h.db.prisma.auditEvent.count({ where: { targetId: result.team.id } }),
        ).toBeGreaterThanOrEqual(2);
        expect(await verifyAuditChain(h.db.prisma)).toMatchObject({ ok: true });
      });

      it('rolls everything back and publishes nothing when the callback throws', async () => {
        const events: ConfigEvent[] = [];
        const auditBefore = await h.db.prisma.auditEvent.count();
        await expect(
          withTransaction(
            h.db.prisma,
            async ({ repos }) => {
              await repos.users.create({ email: 'rollback@acme.com', displayName: 'R' }, { audit });
              throw new Error('abort');
            },
            { publishConfig: (e) => void events.push(e) },
          ),
        ).rejects.toThrow('abort');
        expect(events).toEqual([]);
        expect(await h.db.prisma.user.count({ where: { email: 'rollback@acme.com' } })).toBe(0);
        expect(await h.db.prisma.auditEvent.count()).toBe(auditBefore);
      });

      it('a failing publisher never fails the committed mutation and is reported', async () => {
        const errors: unknown[] = [];
        const user = await withTransaction(
          h.db.prisma,
          ({ repos }) => repos.users.create({ email: 'pubfail@acme.com', displayName: 'P' }),
          {
            publishConfig: () => Promise.reject(new Error('redis down')),
            onPublishError: (e) => void errors.push(e),
          },
        );
        expect(await h.db.prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
        expect(errors).toHaveLength(1);
        const hookErrors: unknown[] = [];
        await withTransaction(
          h.db.prisma,
          ({ afterCommit }) => {
            afterCommit(() => Promise.reject(new Error('hook failed')));
            return Promise.resolve();
          },
          { onPublishError: (e) => void hookErrors.push(e) },
        );
        expect(hookErrors).toHaveLength(1);
      });

      it('standalone repositories give each mutation its own transaction and publish after it', async () => {
        const events: ConfigEvent[] = [];
        const repos = createRepositories(
          h.db.prisma,
          {},
          { publishConfig: (e) => void events.push(e) },
        );
        const team = await repos.teams.create({ slug: 'standalone', displayName: 'S' }, { audit });
        expect(events).toEqual([{ scope: 'team', id: team.id, version: 1n }]);
        // a repository bound to a plain transaction client applies bumps and audits at the end of its own call
        await h.db.prisma.$transaction(async (tx) => {
          const bound = createRepositories(tx);
          await bound.teams.update(team.id, { displayName: 'S2' }, { ifMatch: '*', audit });
        });
        expect(await getConfigVersion(h.db.prisma, 'team', team.id)).toBe(2n);
      });

      it('two units bumping the same scope serialize: versions are exact and unique, audit chain stays valid', async () => {
        const team = await createTeamRepository(h.db.prisma).create({
          slug: 'bump-race',
          displayName: 'B',
        });
        const base = await getConfigVersion(h.db.prisma, 'team', team.id);
        const seen: bigint[] = [];
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            withTransaction(
              h.db.prisma,
              async ({ repos }) => {
                const u = await repos.users.create(
                  { email: `bump${i}@acme.com`, displayName: `B${i}` },
                  { audit },
                );
                await repos.teams.setMembership(
                  { teamId: team.id, userId: u.id, role: 'member' },
                  { audit },
                );
              },
              { publishConfig: (e) => void (e.scope === 'team' && seen.push(e.version)) },
            ),
          ),
        );
        expect(await getConfigVersion(h.db.prisma, 'team', team.id)).toBe(base + 8n);
        expect(new Set(seen).size).toBe(8);
        expect(await verifyAuditChain(h.db.prisma)).toMatchObject({ ok: true });
        expect(await bumpConfigVersion(h.db.prisma, 'team', team.id)).toBe(base + 9n);
      });

      it('opposite call orders across units do not deadlock because bumps are applied in a fixed order', async () => {
        const users = createUserRepository(h.db.prisma);
        const teams = createTeamRepository(h.db.prisma);
        const t1 = await teams.create({ slug: 'dl-1', displayName: '1' });
        const t2 = await teams.create({ slug: 'dl-2', displayName: '2' });
        const members = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            users.create({ email: `dl${i}@acme.com`, displayName: `D${i}` }),
          ),
        );
        const base1 = await getConfigVersion(h.db.prisma, 'team', t1.id);
        await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            withTransaction(h.db.prisma, async ({ repos }) => {
              const [x, y] = [members[i * 2]?.id ?? '', members[i * 2 + 1]?.id ?? ''];
              const order = i % 2 === 0 ? [t1.id, t2.id] : [t2.id, t1.id];
              await repos.teams.setMembership({
                teamId: order[0] ?? '',
                userId: x,
                role: 'member',
              });
              await repos.teams.setMembership({
                teamId: order[1] ?? '',
                userId: y,
                role: 'member',
              });
            }),
          ),
        );
        expect(await getConfigVersion(h.db.prisma, 'team', t1.id)).toBe(base1 + 6n);
      });
    });

    describe('8.6 instances', () => {
      const record = (over: Partial<InstanceRecord> = {}): InstanceRecord => ({
        id: newId(),
        installationId: null,
        catalogVersionId: newId(),
        userId: null,
        kind: 'sandbox',
        replica: 0,
        lastUsedAt: Date.now(),
        failures: [],
        ...over,
      });

      it('round-trips every InstanceRecord field and derives the state', async () => {
        const repo = createInstanceRepository(h.db.prisma);
        const { user, inst } = await seedInstallation();
        const rec = record({
          installationId: inst.id,
          userId: user.id,
          sandbox: { driver: 'kubernetes', id: 'pod-1', address: '10.1.2.3:8080' },
          remoteSession: {
            sessionId: 's1',
            protocolVersion: '2025-03-26',
            url: 'https://x.example/mcp',
            serverCapabilities: { tools: {} },
          },
          startedAt: Date.now() - 5000,
          failures: [1, 2],
          error: { phase: 'start', message: 'boom', stderrTail: ['x'], at: 7 },
          runningVersionId: newId(),
        });
        await repo.save(rec);
        expect(await repo.get(rec.id)).toEqual(rec);
        expect(
          (await h.db.prisma.instance.findUniqueOrThrow({ where: { id: rec.id } })).state,
        ).toBe('failed');
        expect(
          (await h.db.prisma.instance.findUniqueOrThrow({ where: { id: rec.id } })).failureCount,
        ).toBe(2);
        const healed = { ...rec, error: undefined, failures: [] };
        await repo.save(healed);
        expect((await repo.get(rec.id))?.error).toBeUndefined();
        expect(
          (await h.db.prisma.instance.findUniqueOrThrow({ where: { id: rec.id } })).state,
        ).toBe('running');
        expect(await repo.getForInstallation(inst.id)).toMatchObject({ id: rec.id });
        expect(await repo.getForInstallation(newId())).toBeNull();
        expect(await repo.get(newId())).toBeNull();
        await repo.delete(rec.id);
        expect(await repo.get(rec.id)).toBeNull();
      });

      it('replaces the record holding the same installation replica or shared slot', async () => {
        const repo = createInstanceRepository(h.db.prisma);
        const { inst } = await seedInstallation();
        const first = record({ installationId: inst.id });
        const second = record({
          installationId: inst.id,
          catalogVersionId: first.catalogVersionId,
        });
        await repo.save(first);
        await repo.save(second);
        expect(await repo.get(first.id)).toBeNull();
        expect(await repo.get(second.id)).not.toBeNull();
        const versionId = newId();
        const shared = [0, 1, 2].map((replica) => record({ catalogVersionId: versionId, replica }));
        for (const s of shared) await repo.save(s);
        const replacement = record({ catalogVersionId: versionId, replica: 1 });
        await repo.save(replacement);
        expect((await repo.listShared(versionId)).map((r) => r.id)).toEqual([
          shared[0]?.id,
          replacement.id,
          shared[2]?.id,
        ]);
        expect(await repo.listShared(newId())).toEqual([]);
      });

      it('lists running sandboxes per user and claims idle ones exactly once under concurrency (SKIP LOCKED)', async () => {
        const repo = createInstanceRepository(h.db.prisma);
        const { user: u1, inst } = await seedInstallation();
        const { user: u2, inst: inst2 } = await seedInstallation();
        const old = Date.now() - 3_600_000;
        const idle = await Promise.all(
          Array.from({ length: 6 }, async (_, i) => {
            const r = record({
              installationId: i % 2 === 0 ? inst.id : inst2.id,
              replica: i,
              userId: i % 2 === 0 ? u1.id : u2.id,
              startedAt: old,
              lastUsedAt: old + i,
            });
            await repo.save(r);
            return r;
          }),
        );
        const fresh = record({
          installationId: inst.id,
          replica: 99,
          userId: u1.id,
          startedAt: Date.now(),
          lastUsedAt: Date.now(),
        });
        await repo.save(fresh);
        await repo.save(
          record({
            installationId: inst2.id,
            replica: 98,
            userId: u2.id,
            kind: 'remote-legacy',
            startedAt: Date.now(),
          }),
        );
        expect((await repo.listRunning(u1.id)).map((r) => r.userId)).toEqual(Array(4).fill(u1.id));
        expect((await repo.listRunning()).length).toBeGreaterThanOrEqual(7);
        const claims = await Promise.all([
          repo.claimIdle(new Date(Date.now() - 60_000), 4),
          repo.claimIdle(new Date(Date.now() - 60_000), 4),
          repo.claimIdle(new Date(Date.now() - 60_000), 4),
        ]);
        const claimed = claims.flat();
        expect(new Set(claimed).size).toBe(claimed.length);
        expect(claimed.sort()).toEqual(idle.map((r) => r.id).sort());
        expect(await repo.claimIdle(new Date(Date.now() - 60_000), 4)).toEqual([]);
        expect(
          (await h.db.prisma.instance.findUniqueOrThrow({ where: { id: idle[0]?.id } })).state,
        ).toBe('stopping');
        expect((await repo.listRunning(u1.id)).map((r) => r.id)).toEqual([fresh.id]);
      });
    });

    describe('7.5 snapshots', () => {
      const items = (n: number) => ({
        tools: [{ name: `t${n}` }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        instructions: 'be nice',
        serverInfo: { name: 'srv', version: '1.0.0', title: 'Srv' },
        ttlMs: 5000,
      });

      it('stores per (installation, configHash), returns the newest, refreshes identical captures and keeps a few', async () => {
        const store = createSnapshotStore(h.db.prisma);
        const { inst } = await seedInstallation();
        const hash = hex('cfg');
        expect(await store.get(inst.id, hash)).toBeNull();
        await store.put(inst.id, hash, items(1));
        expect(await store.get(inst.id, hash)).toEqual(items(1));
        await store.put(inst.id, hash, { ...items(1), ttlMs: 9000 });
        expect(
          await h.db.prisma.upstreamSnapshot.count({ where: { installationId: inst.id } }),
        ).toBe(1);
        expect((await store.get(inst.id, hash))?.ttlMs).toBe(9000);
        for (let n = 2; n <= 6; n++) await store.put(inst.id, hash, items(n));
        expect(
          await h.db.prisma.upstreamSnapshot.count({ where: { installationId: inst.id } }),
        ).toBe(SNAPSHOTS_KEPT);
        expect((await store.get(inst.id, hash))?.tools).toEqual([{ name: 't6' }]);
        expect(await store.get(inst.id, hex('other'))).toBeNull();
        await store.put(inst.id, hex('bare'), {
          tools: [],
          prompts: [],
          resources: [],
          resourceTemplates: [],
        });
        expect(await store.get(inst.id, hex('bare'))).toEqual({
          tools: [],
          prompts: [],
          resources: [],
          resourceTemplates: [],
        });
      });

      it('keeps catalog reference snapshots apart from installation snapshots and exposes ids and hashes', async () => {
        const store = createSnapshotStore(h.db.prisma);
        const entry = await h.db.prisma.catalogEntry.create({
          data: {
            id: newId(),
            slug: `snap${newId().slice(-8)}`,
            displayName: 'S',
            description: 's',
            visibility: {},
            source: {},
            createdBy: newId(),
          },
        });
        const version = await h.db.prisma.catalogVersion.create({
          data: {
            id: newId(),
            entryId: entry.id,
            label: '1',
            serverSpec: {},
            installForm: {},
            createdBy: newId(),
          },
        });
        const hash = hex('ref');
        expect(await store.getReference(version.id, hash)).toBeNull();
        const id = await store.putReference(version.id, hash, items(1));
        expect(await store.putReference(version.id, hash, items(1))).toBe(id);
        expect(await store.getReference(version.id, hash)).toEqual(items(1));
        expect(await store.getById(id)).toEqual(items(1));
        expect(await store.getById(newId())).toBeNull();
        expect(await store.hashOf(id)).toBe(hash);
        expect(await store.hashOf(newId())).toBeNull();
        expect(await store.get(newId(), hash)).toBeNull();
      });
    });

    describe('15.6 tamper evidence', () => {
      it('reports the first row whose content no longer matches its hash', async () => {
        const log = createAuditLogRepository(h.db.prisma);
        expect(await log.verify()).toMatchObject({ ok: true });
        await h.db.prisma.$executeRawUnsafe(
          `UPDATE audit_events SET action = 'forged' WHERE action = 'late' AND target_id = '1'`,
        );
        expect(await log.verify()).toMatchObject({ ok: false });
      });
    });

    describe('8.8 egress access requests', () => {
      it('dedupes open requests per requester and host, decides once, bumps the installation', async () => {
        const repo = createEgressAccessRequestRepository(h.db.prisma);
        const { user, inst } = await seedInstallation();
        const a = await repo.create(
          { installationId: inst.id, host: 'api.example', port: 443, requesterId: user.id },
          audit,
        );
        const again = await repo.create({
          installationId: inst.id,
          host: 'api.example',
          port: 443,
          requesterId: user.id,
        });
        expect(a.created).toBe(true);
        expect(again).toMatchObject({ created: false, request: { id: a.request.id } });
        await repo.create({
          installationId: inst.id,
          host: 'other.example',
          port: 443,
          requesterId: user.id,
        });
        expect((await repo.list({ installationId: inst.id, status: 'open' })).items).toHaveLength(
          2,
        );
        expect((await repo.list({ requesterId: user.id, limit: 1 })).nextCursor).not.toBeNull();
        const before = await getConfigVersion(h.db.prisma, 'installation', inst.id);
        const decided = await repo.decide(
          a.request.id,
          { status: 'approved', decidedBy: newId() },
          audit,
        );
        expect(decided).toMatchObject({ status: 'approved' });
        expect(await getConfigVersion(h.db.prisma, 'installation', inst.id)).toBe(before + 1n);
        await expect(
          repo.decide(a.request.id, { status: 'rejected', decidedBy: newId() }),
        ).rejects.toMatchObject({ httpStatus: 409 });
        await expect(
          repo.decide(newId(), { status: 'rejected', decidedBy: newId() }),
        ).rejects.toMatchObject({ httpStatus: 404 });
        expect(await repo.get(a.request.id)).toMatchObject({ status: 'approved' });
        expect(await repo.get(newId())).toBeNull();
        const reopened = await repo.create({
          installationId: inst.id,
          host: 'api.example',
          port: 443,
          requesterId: user.id,
        });
        expect(reopened.created).toBe(true);
      });
    });
  },
);

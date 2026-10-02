import { loadConfig, newId } from '@bastion-mcp/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDefaults } from '../src/boot/seed';
import { createInfra, type Infra } from '../src/infra';
import { createScheduler, type Scheduler } from '../src/scheduler';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const timing = { leaderRetryMs: 150, keepaliveMs: 150, pollIntervalMs: 50 };

describe.skipIf(!haveDocker())('21.1 scheduler leader election', () => {
  let env: TestEnv;
  let a: Infra;
  let b: Infra;
  let sa: Scheduler;
  let sb: Scheduler;

  beforeAll(async () => {
    env = await createTestEnv();
    a = createInfra(loadConfig(env.env()));
    b = createInfra(loadConfig(env.env()));
    sa = createScheduler(a, { timing, cron: false });
    sb = createScheduler(b, { timing, cron: false });
  });
  afterAll(async () => {
    await Promise.all([sa.stop(), sb.stop()]);
    await Promise.all([a.close(), b.close()]);
    await env.cleanup();
  });

  it('21.1 exactly one of two schedulers leads; killing its lock connection hands over within seconds; stop releases', async () => {
    sa.start();
    await sa.ready();
    sb.start();
    await sb.ready();
    expect([sa.isLeader(), sb.isLeader()].filter(Boolean)).toHaveLength(1);
    const [leader, follower] = sa.isLeader() ? [sa, sb] : [sb, sa];

    const pid = leader.lockPid();
    expect(pid).toBeGreaterThan(0);
    const admin = new pg.Client({ connectionString: env.databaseUrl });
    await admin.connect();
    const started = Date.now();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    // Both contenders retry every 150 ms, so either may win the freed lock: what matters is that a new lock
    // connection leads within seconds and that there is never more than one leader.
    await until(
      () => {
        const leaders = [leader, follower].filter((s) => s.isLeader());
        return leaders.length === 1 && leaders[0]?.lockPid() !== pid;
      },
      10_000,
      're-election',
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect([leader, follower].filter((s) => s.isLeader())).toHaveLength(1);

    // Releasing on stop lets the other scheduler take the lock.
    const [current, other] = leader.isLeader() ? [leader, follower] : [follower, leader];
    await current.stop();
    await until(() => other.isLeader(), 10_000, 'second handover');
    const locks = await admin.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
    );
    expect(locks.rows[0].n).toBeGreaterThanOrEqual(1);
    await admin.end();
  });
});

describe.skipIf(!haveDocker())(
  '11.5 auto-install fan-out, 25.5 mirror, jobs through graphile-worker',
  () => {
    let env: TestEnv;
    let infra: Infra;
    let scheduler: Scheduler;
    const pushed: string[] = [];
    let admin: { id: string };
    let entryId: string;
    let slug: string;

    const publishedEntry = async (
      name: string,
      auth: Record<string, unknown> = { mode: 'none' },
    ) => {
      const entry = await infra.repos.catalogEntries.create({
        slug: name,
        displayName: name,
        description: 'd',
        createdBy: admin.id,
      });
      const v = await infra.repos.catalogVersions.create({
        entryId: entry.id,
        label: '1.0.0',
        serverSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: `https://${name}.example.com/mcp`,
          auth,
        },
        installForm: {},
        createdBy: admin.id,
      });
      await infra.repos.catalogVersions.publish(v.id);
      return entry;
    };

    beforeAll(async () => {
      env = await createTestEnv();
      infra = createInfra(loadConfig(env.env()));
      await seedDefaults(infra);
      admin = await infra.repos.users.create({
        email: 'admin@example.com',
        displayName: 'A',
        orgRole: 'admin',
      });
      const entry = await publishedEntry('everyone');
      entryId = entry.id;
      slug = entry.slug;
      scheduler = createScheduler(infra, {
        timing,
        cron: false,
        pushMirror: async (id) => void pushed.push(id),
      });
    });
    afterAll(async () => {
      await scheduler.stop();
      await infra.close();
      await env.cleanup();
    });

    it('11.5 fans a policy out in batches of 500 through graphile-worker jobs and installs once per user', async () => {
      const users = Array.from({ length: 1010 }, (_, i) => ({
        id: newId(),
        email: `bulk${i}@example.com`,
        displayName: `B${i}`,
      }));
      await infra.db.prisma.user.createMany({ data: users });
      const policy = await infra.repos.autoInstall.create(
        { catalogEntryId: entryId, target: { all: true }, mode: 'default', createdBy: admin.id },
        { actorType: 'user', actorId: admin.id },
      );

      // The first job handles one batch of 500 and queues the next one.
      const first = (await scheduler.runNow('auto-install:policy', { policyId: policy.id })) as {
        batch: number;
        installed: number;
      };
      expect(first.batch).toBe(500);
      expect(first.installed).toBe(500);
      const queued = await infra.db.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'auto-install:policy'`;
      expect(queued[0]?.n).toBe(1);

      scheduler.start();
      await until(
        async () =>
          (await infra.db.prisma.installation.count({ where: { catalogEntryId: entryId } })) ===
          1011,
        30_000,
        'all users installed',
      );
      expect(
        await infra.db.prisma.autoInstallApplication.count({ where: { policyId: policy.id } }),
      ).toBe(1011);
      const origin = await infra.db.prisma.installation.findFirst({
        where: { catalogEntryId: entryId },
      });
      expect(origin?.origin).toBe(`autoInstall:${policy.id}`);
      expect(origin?.status).toBe('ready');
    });

    it('11.5 a removed default installation is not re-added by the nightly reconciliation', async () => {
      const victim = await infra.db.prisma.installation.findFirstOrThrow({
        where: { catalogEntryId: entryId },
      });
      await infra.db.prisma.installation.delete({ where: { id: victim.id } });
      await scheduler.runNow('auto-install:reconcile');
      await new Promise((r) => setTimeout(r, 1500));
      expect(await infra.db.prisma.installation.count({ where: { catalogEntryId: entryId } })).toBe(
        1010,
      );
      expect(
        await infra.db.prisma.installation.findUnique({ where: { id: victim.id } }),
      ).toBeNull();
    });

    it('11.5 a provisioned user gets matching policies (auto-install:user); needs-input entries start in needs_setup', async () => {
      const oauth = await publishedEntry('needs-input', {
        mode: 'oauth',
        client: { registration: 'dcr' },
      });
      await infra.repos.autoInstall.create(
        { catalogEntryId: oauth.id, target: { all: true }, mode: 'required', createdBy: admin.id },
        { actorType: 'user', actorId: admin.id },
      );
      const late = await infra.repos.users.create({ email: 'late@example.com', displayName: 'L' });
      const result = (await scheduler.runNow('auto-install:user', { userId: late.id })) as {
        installed: number;
      };
      expect(result.installed).toBe(2);
      const mine = await infra.db.prisma.installation.findMany({ where: { ownerId: late.id } });
      expect(mine.map((i) => `${i.slug}:${i.status}`).sort()).toEqual([
        `${slug}:ready`,
        'needs-input:needs_setup',
      ]);
      expect(await scheduler.runNow('auto-install:user', { userId: late.id })).toEqual({
        installed: 0,
      });
    });

    it('11.5 a team-scope policy creates one installation per target team', async () => {
      const t1 = await infra.repos.teams.create({ slug: 'alpha', displayName: 'Alpha' });
      const t2 = await infra.repos.teams.create({ slug: 'beta', displayName: 'Beta' });
      const entry = await publishedEntry('team-tool');
      const policy = await infra.repos.autoInstall.create(
        {
          catalogEntryId: entry.id,
          target: { teamIds: [t1.id, t2.id] },
          mode: 'default',
          scope: 'team',
          createdBy: admin.id,
        },
        { actorType: 'user', actorId: admin.id },
      );
      await scheduler.runNow('auto-install:policy', { policyId: policy.id });
      const rows = await infra.db.prisma.installation.findMany({
        where: { catalogEntryId: entry.id },
      });
      expect(rows.map((r) => r.ownerType)).toEqual(['team', 'team']);
      expect(rows.map((r) => r.ownerId).sort()).toEqual([t1.id, t2.id].sort());
    });

    it('25.5 mirror push runs for one marketplace and for every mirrored one', async () => {
      const m = await infra.db.prisma.marketplace.create({
        data: {
          id: newId(),
          slug: 'mkt',
          displayName: 'M',
          audience: {},
          createdBy: admin.id,
          mirror: { provider: 'github', url: 'https://github.com/acme/mkt.git' },
        },
      });
      await infra.db.prisma.marketplace.create({
        data: { id: newId(), slug: 'plain', displayName: 'P', audience: {}, createdBy: admin.id },
      });
      await scheduler.runNow('mirror:push', { marketplaceId: m.id });
      await scheduler.runNow('mirror:push');
      expect(pushed).toEqual([m.id, m.id]);
    });

    it('21.1 jobs are queued from any process and picked up by the leader', async () => {
      const other = createScheduler(infra, { cron: false });
      const marker = newId();
      await other.enqueue('mirror:push', { marketplaceId: marker }, { jobKey: marker });
      await until(() => pushed.includes(marker), 10_000, 'queued job to run');
      await other.stop();
    });
  },
);

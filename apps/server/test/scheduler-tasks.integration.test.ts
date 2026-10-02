import { loadConfig, newId, redisKeys } from '@bastion-mcp/core';
import { createCallLogRepository, listPartitions } from '@bastion-mcp/db';
import { type KubeApi, type KubeObject, KubernetesDriver, LABELS } from '@bastion-mcp/sandbox';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDefaults } from '../src/boot/seed';
import { createInfra, type Infra } from '../src/infra';
import { createScheduler, type Scheduler } from '../src/scheduler';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';

const DAY = 86_400_000;
const dayStart = (offsetDays: number) => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays, 12, 0, 0),
  );
};

class FakeKube implements KubeApi {
  deleted: string[] = [];
  constructor(private claims: KubeObject[]) {}
  async get(_k: string, name: string) {
    return this.claims.find((c) => c.metadata.name === name) ?? null;
  }
  async create(_k: 'claim', body: KubeObject) {
    return body;
  }
  async patch() {}
  async delete(kind: string, name: string) {
    if (kind === 'claim') this.deleted.push(name);
  }
  async list(kind: string) {
    return kind === 'claim' ? this.claims : [];
  }
  async deleteMatching() {}
  // biome-ignore lint/correctness/useYield: never watched in these tests
  async *watchClaim(): AsyncIterable<KubeObject> {}
}

const claim = (name: string, labels: Record<string, string>): KubeObject =>
  ({ metadata: { name, labels }, spec: {} }) as unknown as KubeObject;

describe.skipIf(!haveDocker())('15.5/11.5/8.4/22.3 scheduler tasks', () => {
  let env: TestEnv;
  let infra: Infra;
  let now = new Date();
  const fake: { fetchCalls: string[] } = { fetchCalls: [] };
  const refreshed: string[] = [];
  const scheduler = (): Scheduler => schedulerRef;
  let schedulerRef: Scheduler;

  beforeAll(async () => {
    env = await createTestEnv();
    infra = createInfra(loadConfig(env.env()));
    await seedDefaults(infra);
    schedulerRef = createScheduler(infra, {
      now: () => now,
      cron: false,
      timing: { leaderRetryMs: 200, keepaliveMs: 200, pollIntervalMs: 100 },
      refreshUpstreamToken: async (p, i) => void refreshed.push(`${p}:${i}`),
      fetch: (async (url: string) => {
        fake.fetchCalls.push(String(url));
        const body = {
          servers: [
            {
              server: {
                name: 'io.example/echo',
                description: 'Echo server',
                version: '1.0.0',
                remotes: [{ type: 'streamable-http', url: 'https://echo.example.com/mcp' }],
              },
              _meta: {
                'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true },
              },
            },
          ],
          metadata: { count: 1 },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
  });
  afterAll(async () => {
    await schedulerRef.stop();
    await infra.close();
    await env.cleanup();
  });

  it('15.5 rollups: minute, hour and day stats come from call_log and a second run is idempotent', async () => {
    const base = dayStart(1);
    const principalId = newId();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: newId(),
      ts: new Date(base.getTime() + (i % 3) * 60_000 + i * 1000),
      durationMs: 20,
      principalType: 'user' as const,
      principalId,
      method: 'tools/call',
      itemName: 'gh__list',
      outcome: i % 5 === 0 ? ('tool_error' as const) : ('ok' as const),
      eraDown: 'modern',
      coldStart: false,
      bytesIn: 1,
      bytesOut: 10,
    }));
    await createCallLogRepository(infra.db.prisma).insertBatch(rows);
    now = new Date(base.getTime() + 2 * 3_600_000);
    await scheduler().runNow('rollups');
    const first = await infra.db.prisma.callStatsMinute.aggregate({
      _sum: { count: true, errorCount: true },
    });
    expect(first._sum.count).toBe(30);
    expect(first._sum.errorCount).toBe(6);
    await scheduler().runNow('rollups');
    const second = await infra.db.prisma.callStatsMinute.aggregate({ _sum: { count: true } });
    expect(second._sum.count).toBe(30);
    expect(await infra.db.prisma.callStatsHour.count()).toBeGreaterThan(0);
  });

  it('15.5 partitions exist seven days ahead and retention drops old partitions, stats rows and audit prefix', async () => {
    await scheduler().runNow('partitions:ensure');
    const parts = await listPartitions(infra.db.prisma, 'call_log');
    expect(parts.length).toBeGreaterThanOrEqual(8);
    await infra.db.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS call_log_20200101 PARTITION OF call_log FOR VALUES FROM ('2020-01-01') TO ('2020-01-02')`,
    );
    await infra.db.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS distribution_events_20200101 PARTITION OF distribution_events FOR VALUES FROM ('2020-01-01') TO ('2020-01-02')`,
    );
    now = new Date();
    const result = (await scheduler().runNow('retention:apply')) as {
      dropped: Record<string, number>;
    };
    expect(result.dropped.call_log).toBeGreaterThanOrEqual(1);
    expect(result.dropped.distribution_events).toBeGreaterThanOrEqual(1);
    expect(await listPartitions(infra.db.prisma, 'call_log')).not.toContain('call_log_20200101');
  });

  it('11.6 registry sync mirrors an enabled source once per interval and skips disabled ones', async () => {
    const [source] = await infra.repos.registrySources.list();
    if (!source) throw new Error('official source missing');
    expect(
      ((await scheduler().runNow('registry:sync-due')) as { synced: string[] }).synced,
    ).toEqual([]);
    await infra.repos.registrySources.save({ ...source, enabled: true });
    now = new Date();
    const done = (await scheduler().runNow('registry:sync-due')) as { synced: string[] };
    expect(done.synced).toEqual([source.id]);
    expect(fake.fetchCalls[0]).toContain('/v0.1/servers?limit=100');
    const servers = await infra.repos.registryServers.list(source.id);
    expect(servers.map((s) => s.name)).toEqual(['io.example/echo']);
    const synced = await infra.repos.registrySources.get(source.id);
    expect(synced?.lastSync?.ok).toBe(true);
    const again = (await scheduler().runNow('registry:sync-due')) as { synced: string[] };
    expect(again.synced).toEqual([]);
    const full = (await scheduler().runNow('registry:full-resync')) as { synced: string[] };
    expect(full.synced).toEqual([source.id]);
  });

  it('9.6 the daily token sweep refreshes every token that expires within the day', async () => {
    const user = await infra.repos.users.create({ email: 'sweep@example.com', displayName: 'S' });
    const entry = await infra.repos.catalogEntries.create({
      slug: 'sweepy',
      displayName: 'Sweepy',
      description: 'd',
      createdBy: user.id,
    });
    const inst = await infra.repos.installations.create({
      ownerType: 'user',
      ownerId: user.id,
      personalSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: 'https://s.example.com/mcp',
        auth: { mode: 'none' },
      },
      slug: 'sweep',
      displayName: 'Sweep',
    });
    const secret = await infra.vault.put({
      scope: 'user',
      ownerId: user.id,
      name: 'upstream-token:sweep',
      plaintext: '{}',
    });
    await infra.repos.upstreamTokens.put({
      principalType: 'user',
      principalId: user.id,
      installationId: inst.id,
      issuer: 'https://as.example.com',
      secretId: secret.id,
      scopes: [],
      expiresAt: new Date(Date.now() + 3_600_000),
      status: 'valid',
      updatedAt: new Date(),
    });
    expect(entry.slug).toBe('sweepy');
    now = new Date();
    const result = (await scheduler().runNow('upstream-tokens:sweep')) as { refreshed: number };
    expect(result.refreshed).toBe(1);
    expect(refreshed).toContain(`${user.id}:${inst.id}`);
  });

  it('8.4 sandbox GC deletes claims of unknown instances and expired leases and keeps live ones', async () => {
    const redis = new Redis(env.redisUrl);
    const hourAgo = new Date(Date.now() - 3_600_000);
    const live = newId();
    const expired = newId();
    const unknown = newId();
    for (const id of [live, expired]) {
      await infra.db.prisma.instance.create({
        data: { id, kind: 'sandbox', state: 'running', lastUsedAt: hourAgo, replica: 0 },
      });
    }
    await redis.set(redisKeys.lease(live), 'worker-1', 'EX', 60);
    const kube = new FakeKube([
      claim('bst-live', { [LABELS.instance]: live }),
      claim('bst-expired', { [LABELS.instance]: expired }),
      claim('bst-unknown', { [LABELS.instance]: unknown }),
    ]);
    const sched = createScheduler(infra, {
      driver: new KubernetesDriver({ api: kube }),
      cron: false,
    });
    const result = (await sched.runNow('sandbox:gc')) as { deleted: string[] };
    expect(result.deleted.sort()).toEqual(['bst-expired', 'bst-unknown']);
    expect(kube.deleted.sort()).toEqual(['bst-expired', 'bst-unknown']);
    await redis.quit();
  });

  it('22.3 key rotation creates new keys when due, retires expired ones and publishes the change', async () => {
    const sub = new Redis(env.redisUrl);
    const messages: string[] = [];
    await sub.subscribe('bastion:config');
    sub.on('message', (_c, m) => void messages.push(m));
    const store = (infra.repos as unknown as { keyStore: import('@bastion-mcp/secrets').KeyStore })
      .keyStore;
    const before = await store.listSigningKeys('as');
    expect(before).toHaveLength(1);
    now = new Date(Date.now() + 40 * DAY);
    const results = (await scheduler().runNow('keys:rotate')) as {
      purpose: string;
      created?: string;
      retired: string[];
    }[];
    const as = results.find((r) => r.purpose === 'as');
    expect(as?.created).toBeDefined();
    expect(as?.retired).toEqual([before[0]?.kid]);
    const afterKeys = await store.listSigningKeys('as');
    expect(afterKeys.map((k) => k.kid)).toEqual([as?.created]);
    const upstream = results.find((r) => r.purpose === 'upstream-client');
    expect(upstream?.created).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(messages.some((m) => m.includes('signing_keys'))).toBe(true);
    expect(messages.some((m) => m.includes('state_keys'))).toBe(true);
    await sub.quit();
    now = new Date();
  });

  it('22.3 KEK re-wrap has nothing to do when every row is under the current KEK', async () => {
    await infra.vault.put({ scope: 'org', ownerId: null, name: 'k', plaintext: 'v' });
    expect(await scheduler().runNow('secrets:rewrap')).toEqual({ rewrapped: 0, failed: [] });
  });

  it('9.3 expired oidc models are purged', async () => {
    await infra.repos.oidcModels.upsert({
      id: 'old',
      type: 'Interaction',
      payload: {},
      grantId: null,
      userCode: null,
      uid: 'u1',
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    });
    const result = (await scheduler().runNow('oidc:cleanup')) as { oidcModels: number };
    expect(result.oidcModels).toBeGreaterThanOrEqual(1);
  });

  it('13.6 pin re-verification calls back for pinned installations only', async () => {
    const calls: string[] = [];
    const sched = createScheduler(infra, {
      reverifyPins: async (id) => void calls.push(id),
      cron: false,
    });
    const user = await infra.repos.users.create({ email: 'pin@example.com', displayName: 'P' });
    const pinned = await infra.repos.installations.create({
      ownerType: 'user',
      ownerId: user.id,
      personalSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: 'https://p.example.com/mcp',
        auth: { mode: 'none' },
      },
      slug: 'pinned',
      displayName: 'Pinned',
    });
    await infra.repos.installations.create({
      ownerType: 'user',
      ownerId: user.id,
      personalSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: 'https://q.example.com/mcp',
        auth: { mode: 'none' },
      },
      slug: 'unpinned',
      displayName: 'Unpinned',
    });
    await infra.db.prisma.definitionPin.create({
      data: {
        id: newId(),
        installationId: pinned.id,
        itemKind: 'tool',
        itemKey: 't',
        hash: new Uint8Array(32),
        definition: {},
      },
    });
    await sched.runNow('pins:reverify');
    expect(calls).toEqual([pinned.id]);
  });
});

import type { ApiEvent } from '@bastion-mcp/api';
import { type FakeModernServer, startFakeModernServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogApiPorts } from '../src/adapters/api/catalog';
import { createEventBus } from '../src/adapters/api/events';
import { createInstallationApiPorts } from '../src/adapters/api/installations';
import { createGuardService } from '../src/adapters/guards';
import { createPolicyService } from '../src/adapters/policy';
import { createUpstreamAccess } from '../src/adapters/upstream-access';
import type { AuthServices } from '../src/contracts';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { startPoisonedServer } from './helpers/poisoned-server';
import {
  seedInstallation,
  startTestWorker,
  stubAuth,
  type TestWorker,
} from './helpers/worker-harness';

type Row = { id: string };

describe.skipIf(!haveDocker())('11.2/11.3 catalog TEST flow and try console', () => {
  let env: TestEnv;
  let worker: TestWorker;
  let upstream: FakeModernServer;
  let poisoned: Awaited<ReturnType<typeof startPoisonedServer>>;
  let authorId: string;
  const events: ApiEvent[] = [];

  const authOf = (): AuthServices =>
    ({
      ...stubAuth(worker.infra),
      principalStore: worker.infra.repos.principals,
    }) as unknown as AuthServices;
  const guards = () => createGuardService(worker.infra);

  const newVersion = async (
    url: string,
    slug: string,
  ): Promise<{ entryId: string; versionId: string }> => {
    const entry = await worker.infra.repos.catalogEntries.create({
      slug,
      displayName: slug,
      description: `${slug} server`,
      createdBy: authorId,
    });
    const version = await worker.infra.repos.catalogVersions.create({
      entryId: entry.id,
      label: '1',
      serverSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url,
        auth: { mode: 'none' },
      },
      installForm: { variables: [], secrets: [] },
      createdBy: authorId,
    });
    return { entryId: entry.id, versionId: version.id };
  };

  const waitForRun = async (
    port: ReturnType<typeof createCatalogApiPorts>['tests'],
    versionId: string,
  ) => {
    for (let i = 0; i < 240; i += 1) {
      const run = await port.latest(versionId);
      if (run && run.status !== 'running') return run;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('the test run did not finish');
  };

  beforeAll(async () => {
    env = await createTestEnv();
    upstream = await startFakeModernServer();
    poisoned = await startPoisonedServer();
    worker = await startTestWorker(env, {
      auth: (infra) =>
        ({ ...stubAuth(infra), principalStore: infra.repos.principals }) as unknown as AuthServices,
    });
    const author = await worker.infra.repos.users.create({
      email: 'author@acme.example',
      displayName: 'Author',
      orgRole: 'admin',
    });
    authorId = author.id;
  });

  afterAll(async () => {
    await worker?.stop();
    await upstream?.close();
    await poisoned?.close();
    await env?.cleanup();
  });

  it('11.3 TEST connects as the author, records the snapshot, pins, era and publishes progress events', async () => {
    const guardService = guards();
    await guardService.ready();
    const bus = createEventBus({
      redis: worker.infra.redis,
      duplicate: worker.infra.duplicateRedis,
    });
    bus.subscribe((e) => events.push(e));
    const ports = createCatalogApiPorts(worker.infra, authOf(), {
      worker: worker.worker,
      guards: guardService,
      events: bus,
    });
    const { entryId, versionId } = await newVersion(upstream.url, 'fake-modern');

    const started = await ports.tests.start({ entryId, versionId, requestedBy: authorId });
    expect(started.status).toBe('running');
    const run = await waitForRun(ports.tests, versionId);

    expect(run.status).toBe('passed');
    const byId = Object.fromEntries(run.steps.map((s) => [s.id, s]));
    expect(byId.connect?.status).toBe('passed');
    expect(byId.snapshot?.detail).toMatch(/tools/);
    expect(byId.scan?.status).toBe('passed');
    expect(byId.era?.detail).toMatch(/modern/);

    const version = await worker.infra.repos.catalogVersions.get(versionId);
    expect(version?.referenceSnapshotId).toBeTruthy();
    expect(version?.protocolEra).toBe('modern');
    expect((version?.testResult as { status?: string } | null)?.status).toBe('passed');
    const snapshot = await worker.infra.repos.snapshots.getById(
      version?.referenceSnapshotId as string,
    );
    expect((snapshot?.tools ?? []).map((t) => (t as { name: string }).name)).toContain('echo');
    const pins = await worker.infra.repos.definitionPins.pinSet({ catalogVersionId: versionId });
    expect(Object.keys(pins ?? {})).toContain('tool:echo');

    // 18.1: one event per step transition, addressed to the author, keyed by the version.
    const progress = events.filter((e) => e.type === 'test.progress' && e.topic === versionId);
    expect(progress.length).toBeGreaterThanOrEqual(8);
    expect(progress.every((e) => e.audience.userIds?.includes(authorId))).toBe(true);
    await bus.close();
  });

  it('13.6 a tool description with hidden Unicode tag characters fails the test', async () => {
    const guardService = guards();
    await guardService.ready();
    const bus = createEventBus({
      redis: worker.infra.redis,
      duplicate: worker.infra.duplicateRedis,
    });
    const ports = createCatalogApiPorts(worker.infra, authOf(), {
      worker: worker.worker,
      guards: guardService,
      events: bus,
    });
    const { entryId, versionId } = await newVersion(poisoned.url, 'poisoned');
    await ports.tests.start({ entryId, versionId, requestedBy: authorId });
    const run = await waitForRun(ports.tests, versionId);
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.id === 'scan')?.status).toBe('failed');
    await bus.close();
  });

  it('11.3 an unreachable upstream fails at the connect step with a reason', async () => {
    const guardService = guards();
    await guardService.ready();
    const bus = createEventBus({
      redis: worker.infra.redis,
      duplicate: worker.infra.duplicateRedis,
    });
    const ports = createCatalogApiPorts(worker.infra, authOf(), {
      worker: worker.worker,
      guards: guardService,
      events: bus,
    });
    const { entryId, versionId } = await newVersion('http://127.0.0.1:9/mcp', 'unreachable');
    await ports.tests.start({ entryId, versionId, requestedBy: authorId });
    const run = await waitForRun(ports.tests, versionId);
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.id === 'connect')?.status).toBe('failed');
    await bus.close();
  });

  it('11.4 try runs a call through the full pipeline as the caller and the call reaches call_log', async () => {
    const policy = createPolicyService(worker.infra);
    const seeded = await seedInstallation(worker.infra, {
      email: 'member@acme.example',
      slug: 'try-me',
      spec: {
        type: 'remote',
        transport: 'streamable-http',
        url: upstream.url,
        auth: { mode: 'none' },
      },
    });
    const installation = { id: seeded.installationId };
    await policy.rebuild(); // the engine holds a snapshot of the data; the server rebuilds it on config events
    const access = createUpstreamAccess(worker.infra, authOf(), worker.worker);
    const ports = createInstallationApiPorts(worker.infra, authOf(), {
      worker: worker.worker,
      policy,
      access,
    });
    const listed = await ports.definitions.listItems(installation.id, seeded.userId);
    expect(listed.status).toBe('ok');

    const out = await ports.tryCall.run({
      installationId: installation.id,
      principalId: seeded.userId,
      request: { kind: 'tool', name: 'echo', arguments: { text: 'from try' } },
    });
    expect(out.isError).toBe(false);
    expect(JSON.stringify(out.result)).toContain('from try');

    const unknown = await ports.tryCall.run({
      installationId: installation.id,
      principalId: seeded.userId,
      request: { kind: 'tool', name: 'does-not-exist', arguments: {} },
    });
    expect(unknown.isError).toBe(true);

    await expect
      .poll(
        async () => {
          const page = await worker.infra.repos.callLog.list({ limit: 100 });
          return page.items.some((r) => r.method === 'tools/call' && r.itemName?.endsWith('echo'));
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  it('8.6 restart and log tail work for an installation without a sandbox instance', async () => {
    const policy = createPolicyService(worker.infra);
    await policy.rebuild();
    const ports = createInstallationApiPorts(worker.infra, authOf(), {
      worker: worker.worker,
      policy,
    });
    const rows = (await worker.infra.repos.installations.list({ ownerId: authorId }))
      .items as Row[];
    const id = rows[0]?.id as string;
    await expect(ports.runtime.restart(id)).resolves.toBeUndefined();
    await expect(ports.runtime.stop(id)).resolves.toBeUndefined();
    expect(await ports.runtime.logTail(id, 10)).toEqual([]);
    expect(await ports.runtime.egress(id, 10)).toEqual([]);
  });
});

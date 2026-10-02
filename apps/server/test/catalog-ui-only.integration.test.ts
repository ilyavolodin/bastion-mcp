import { loadConfig } from '@bastion-mcp/core';
import {
  type FakeModernServer,
  startFakeLegacyHttpServer,
  startFakeModernServer,
} from '@bastion-mcp/testkit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogApiPorts } from '../src/adapters/api/catalog';
import { createEventBus } from '../src/adapters/api/events';
import { createInstallationApiPorts } from '../src/adapters/api/installations';
import { createAuthServices } from '../src/adapters/auth';
import { createGuardService } from '../src/adapters/guards';
import { createLimitService } from '../src/adapters/limits';
import { createPolicyService } from '../src/adapters/policy';
import { seedDefaults } from '../src/boot/seed';
import type { AuthServices, WorkerServices } from '../src/contracts';
import { createInfra, type Infra } from '../src/infra';
import { createWorker } from '../src/roles/worker';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { proxyFetch } from './helpers/proxy-fetch';
import { freePort, seedInstallation } from './helpers/worker-harness';

describe.skipIf(!haveDocker())(
  '4.1/4.2 ui-only process reaches workers through the gateway',
  () => {
    let env: TestEnv;
    let workerInfra: Infra;
    let worker: WorkerServices;
    let workerApp: FastifyInstance;
    let uiInfra: Infra;
    let uiAuth: AuthServices;
    let modern: FakeModernServer;
    let legacy: Awaited<ReturnType<typeof startFakeLegacyHttpServer>>;

    beforeAll(async () => {
      env = await createTestEnv();
      modern = await startFakeModernServer();
      legacy = await startFakeLegacyHttpServer();
      const httpPort = await freePort();
      const workerConfig = loadConfig(
        env.env({
          BASTION_ROLE: 'worker',
          BASTION_HTTP_PORT: String(httpPort),
          BASTION_INTERNAL_PORT: String(await freePort()),
          BASTION_EGRESS_PORT: String(await freePort()),
          BASTION_PRIVATE_UPSTREAM_CIDRS: '127.0.0.0/8',
          BASTION_INSECURE_UPSTREAM_HOSTS: '127.0.0.1',
        }),
      );
      workerInfra = createInfra(workerConfig, {
        workerId: 'w-ui-only',
        listenHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        allowInsecureHttp: true,
      });
      await seedDefaults(workerInfra);
      const workerAuth = await createAuthServices(workerInfra);
      const policy = createPolicyService(workerInfra);
      worker = await createWorker(workerInfra, workerAuth, {
        policy,
        guards: createGuardService(workerInfra),
        limits: createLimitService(workerInfra),
      });
      workerApp = Fastify({ logger: false, trustProxy: true, forceCloseConnections: true });
      await worker.registerRoutes(workerApp);
      await worker.start();
      await workerApp.listen({ port: httpPort, host: '127.0.0.1' });

      // The ui-only process: no worker, outbound calls to the public URL are routed to the worker above.
      const uiConfig = loadConfig(env.env({ BASTION_ROLE: 'ui' }));
      uiInfra = createInfra(uiConfig, {
        workerId: 'ui-1',
        allowInsecureHttp: true,
        fetch: proxyFetch(httpPort) as typeof fetch,
      });
      uiAuth = await createAuthServices(uiInfra);
    });

    afterAll(async () => {
      await uiAuth?.close();
      await uiInfra?.close();
      await worker?.stop(500);
      await workerApp?.close();
      await workerInfra?.close();
      await modern?.close();
      await legacy?.close();
      await env?.cleanup();
    });

    const seed = (slug: string, url: string) =>
      seedInstallation(workerInfra, {
        email: 'member@acme.example',
        slug,
        spec: { type: 'remote', transport: 'streamable-http', url, auth: { mode: 'none' } },
      });

    it('11.4 definitions list a modern and a legacy remote as the user through the worker', async () => {
      const policy = createPolicyService(uiInfra);
      const ports = createInstallationApiPorts(uiInfra, uiAuth, { policy });
      for (const [slug, url] of [
        ['ui-modern', modern.url],
        ['ui-legacy', legacy.url],
      ] as const) {
        const seeded = await seed(slug, url);
        const out = await ports.definitions.listItems(seeded.installationId, seeded.userId);
        expect(out.status, slug).toBe('ok');
        if (out.status === 'ok') expect(out.items.tools.length, slug).toBeGreaterThan(0);
      }
    });

    it('11.4 try calls a tool through the worker pipeline from a ui-only process', async () => {
      const policy = createPolicyService(uiInfra);
      const ports = createInstallationApiPorts(uiInfra, uiAuth, { policy });
      const seeded = await seed('ui-try', modern.url);
      const out = await ports.tryCall.run({
        installationId: seeded.installationId,
        principalId: seeded.userId,
        request: { kind: 'tool', name: 'echo', arguments: { text: 'via gateway' } },
      });
      expect(out.isError).toBe(false);
      expect(JSON.stringify(out.result)).toContain('via gateway');
    });

    it('11.3 the TEST flow runs from a ui-only process and records the era', async () => {
      const guards = createGuardService(uiInfra);
      await guards.ready();
      const bus = createEventBus({ redis: uiInfra.redis, duplicate: uiInfra.duplicateRedis });
      const ports = createCatalogApiPorts(uiInfra, uiAuth, { guards, events: bus });
      const author = await uiInfra.repos.users.create({
        email: 'author@acme.example',
        displayName: 'Author',
        orgRole: 'admin',
      });
      const entry = await uiInfra.repos.catalogEntries.create({
        slug: 'ui-test-flow',
        displayName: 'UI test flow',
        description: 'x',
        createdBy: author.id,
      });
      const version = await uiInfra.repos.catalogVersions.create({
        entryId: entry.id,
        label: '1',
        serverSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: modern.url,
          auth: { mode: 'none' },
        },
        installForm: { variables: [], secrets: [] },
        createdBy: author.id,
      });
      await ports.tests.start({ entryId: entry.id, versionId: version.id, requestedBy: author.id });
      let run = await ports.tests.latest(version.id);
      for (let i = 0; i < 120 && run?.status === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        run = await ports.tests.latest(version.id);
      }
      expect(run?.status, JSON.stringify(run)).toBe('passed');
      const stored = await uiInfra.repos.catalogVersions.get(version.id);
      expect(stored?.referenceSnapshotId).toBeTruthy();
      // The hidden test installation is disabled again once the run is over.
      const hidden = await uiInfra.repos.installations.list({ ownerId: author.id });
      expect(hidden.items.every((i) => i.enabled === false)).toBe(true);
      await bus.close();
    });
  },
);

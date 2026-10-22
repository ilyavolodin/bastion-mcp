/**
 * The composition root (4.1, 4.2, 5.2): builds the infrastructure, the identity services, and then the route groups
 * and background loops that `BASTION_ROLE` selects:
 *
 *   worker  MCP routes, internal RPC listener, egress proxy, sandbox driver, worker registry
 *   ui      API, authorization server, interaction pages, IdP login, connect, SCIM, subregistry, plugins, SPA,
 *           health, leader-elected scheduler
 *   all     both on one port
 */
import { registerApi } from '@bastion-mcp/api';
import type { BastionConfig } from '@bastion-mcp/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApiDeps } from './adapters/api';
import { createAuthServices, createInstallationLookup } from './adapters/auth';
import { createCatalogInstallPort } from './adapters/downstream/catalog-install';
import { createSkillsProvider } from './adapters/downstream/skills';
import { createGuardService } from './adapters/guards';
import { createLimitService } from './adapters/limits';
import { createPluginServices } from './adapters/plugin-services';
import { createPolicyService } from './adapters/policy';
import { createMaintenance, registerMaintenanceGate } from './backup/maintenance';
import { bootstrapAdminUser } from './boot/bootstrap-admin';
import { keyStoreOf } from './boot/key-store';
import { migrate } from './boot/migrate';
import { assertMigrationsCurrent, PendingMigrationsError } from './boot/preflight';
import { seedDefaults } from './boot/seed';
import { isProduction, loadServerConfig, type ServerOptions } from './config';
import type { AuthServices, WorkerServices } from './contracts';
import { createHealthRegistry, registerHealthRoutes } from './http/health';
import { registerSecurityHeaders, registerSpa } from './http/shell';
import { registerAuthRoutes } from './http/ui';
import { registerPluginRoutes } from './http/ui/plugins';
import { registerSubregistryRoutes } from './http/ui/registry';
import { createInfra, type Infra } from './infra';
import { pollUntil } from './poll';
import { createWorker } from './roles/worker';
import { createScheduler } from './scheduler';
import { BODY_LIMIT_BYTES, DRAIN_GRACE_MS, KEYS_POLL_MS, KEYS_WAIT_MS } from './timing';

export type RunningServer = {
  config: BastionConfig;
  infra: Infra;
  app: FastifyInstance;
  auth: AuthServices;
  worker: WorkerServices | undefined;
  scheduler: ReturnType<typeof createScheduler> | undefined;
  /** Port the HTTP listener bound to. */
  port: number;
  /** Graceful shutdown (21.2). Idempotent. */
  stop(): Promise<void>;
};

/** Waits until the ui role has created the signing and state keys (a worker may start first). */
const waitForKeys = async (infra: Infra, timeoutMs = KEYS_WAIT_MS): Promise<void> => {
  const found = await pollUntil(
    async () =>
      (
        await keyStoreOf(infra)
          .listStateKeys()
          .catch(() => [])
      ).length > 0,
    Boolean,
    { timeoutMs, intervalMs: KEYS_POLL_MS, clock: infra.clock },
  );
  if (!found) throw new Error('state keys do not exist yet: start the ui role once');
};

export const startServer = async (
  env: Record<string, string | undefined> = process.env,
  options: ServerOptions = {},
): Promise<RunningServer> => {
  const config = loadServerConfig(env);
  const infra = createInfra(config, options, env);
  const { logger } = infra;
  try {
    // Migrations: refuse to boot against pending ones in production; elsewhere apply them for convenience.
    if (!options.skipMigrationCheck) {
      try {
        await assertMigrationsCurrent(config.databaseUrl);
      } catch (error) {
        if (!(error instanceof PendingMigrationsError)) throw error;
        // Production refuses to boot against pending migrations (20.1); elsewhere they are applied for convenience.
        if (isProduction(env)) throw error;
        logger.info({ pending: error.status.pending }, 'applying pending migrations');
        await migrate(config.databaseUrl);
      }
    }
    if (config.roles.ui) {
      await seedDefaults(infra);
      await bootstrapAdminUser(infra);
    } else {
      await waitForKeys(infra);
    }

    const closers: (() => Promise<void>)[] = [];
    const auth = await createAuthServices(infra);
    const app = Fastify({
      logger: false,
      trustProxy: true,
      forceCloseConnections: true,
      bodyLimit: BODY_LIMIT_BYTES,
    });

    registerMaintenanceGate(app, createMaintenance(infra.redis));

    await registerSecurityHeaders(app, {
      publicUrl: config.publicUrl,
      extraOrigins: options.extraCorsOrigins,
    });

    const policy = createPolicyService(infra);
    await policy.rebuild();
    const stopPolicyWatch = policy.watch();
    const guards = createGuardService(infra);
    const limits = createLimitService(infra);
    const stopLimitWatch = limits.watch();

    let worker: WorkerServices | undefined;
    if (config.roles.worker) {
      worker = await createWorker(infra, auth, {
        policy,
        guards,
        limits,
        skills: createSkillsProvider(infra),
        catalogInstall: createCatalogInstallPort(infra),
      });
      await worker.registerRoutes(app);
    }

    let scheduler: ReturnType<typeof createScheduler> | undefined;
    const installationLookup = createInstallationLookup(infra);
    if (config.roles.ui) {
      const api = await buildApiDeps(infra, auth, {
        worker,
        policy,
        guards,
        limits,
      });
      closers.push(() => api.close());
      await registerApi(app, api.deps);
      await registerAuthRoutes(app, { infra, auth });
      await registerSubregistryRoutes(app, { infra, auth });
      await registerPluginRoutes(app, { infra, auth });
      await registerSpa(app, {
        publicUrl: config.publicUrl,
        publicDir: options.publicDir ?? infra.env.publicDir,
      });
      if (options.scheduler !== false) {
        scheduler = createScheduler(infra, {
          driver: worker?.driver,
          onKeysRotated: () => auth.refreshKeys(),
          pushMirror: (marketplaceId) => createPluginServices(infra).mirror.push(marketplaceId),
          refreshUpstreamToken: async (principalId, installationId) => {
            const installation = await installationLookup.get(installationId);
            if (installation)
              await auth.broker.refresh({ type: 'user', id: principalId }, installation);
          },
        });
      }
    }

    registerHealthRoutes(app, createHealthRegistry({ infra, worker }));

    await worker?.start();
    await app.listen({ port: config.httpPort, host: options.listenHost ?? '0.0.0.0' });
    await scheduler?.start();
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : config.httpPort;
    logger.info({ role: config.role, port }, 'bastion listening');

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        logger.info('shutting down');
        // ui: stop the scheduler (releases the leader lock), then close the server; worker: drain (21.2).
        await scheduler?.stop().catch(() => undefined);
        await worker?.stop(DRAIN_GRACE_MS).catch(() => undefined);
        stopPolicyWatch();
        stopLimitWatch();
        await app.close().catch(() => undefined);
        for (const close of closers) await close().catch(() => undefined);
        await auth.close().catch(() => undefined);
        await infra.close();
      })();
      return stopping;
    };
    return { config, infra, app, auth, worker, scheduler, port, stop };
  } catch (error) {
    await infra.close().catch(() => undefined);
    throw error;
  }
};

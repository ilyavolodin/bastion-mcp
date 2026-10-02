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
import { bootstrapAdminUser } from './boot/bootstrap-admin';
import { keyStoreOf } from './boot/key-store';
import { migrate } from './boot/migrate';
import { assertMigrationsCurrent, PendingMigrationsError } from './boot/preflight';
import { seedDefaults } from './boot/seed';
import { loadServerConfig, type ServerOptions } from './config';
import type { AuthServices, WorkerServices } from './contracts';
import { createHealthRegistry, registerHealthRoutes } from './http/health';
import { registerSecurityHeaders, registerSpa } from './http/shell';
import { registerAuthRoutes } from './http/ui';
import { registerPluginRoutes } from './http/ui/plugins';
import { registerSubregistryRoutes } from './http/ui/registry';
import { createInfra, type Infra } from './infra';
import { createWorker } from './roles/worker';
import { createScheduler } from './scheduler';

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

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Waits until the ui role has created the signing and state keys (a worker may start first). */
const waitForKeys = async (infra: Infra, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const keys = await keyStoreOf(infra)
      .listStateKeys()
      .catch(() => []);
    if (keys.length > 0) return;
    if (Date.now() > deadline)
      throw new Error('state keys do not exist yet: start the ui role once');
    await new Promise((r) => setTimeout(r, 1000));
  }
};

export const startServer = async (
  env: Record<string, string | undefined> = process.env,
  options: ServerOptions = {},
): Promise<RunningServer> => {
  const config = loadServerConfig(env);
  const infra = createInfra(config, options);
  const { logger } = infra;
  try {
    // Migrations: refuse to boot against pending ones in production; elsewhere apply them for convenience.
    if (!options.skipMigrationCheck) {
      try {
        await assertMigrationsCurrent(config.databaseUrl);
      } catch (error) {
        if (!(error instanceof PendingMigrationsError)) throw error;
        // Production refuses to boot against pending migrations (20.1); elsewhere they are applied for convenience.
        if (isProduction()) throw error;
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
      bodyLimit: 10 * 1024 * 1024,
    });

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
      await registerSpa(app, { publicUrl: config.publicUrl, publicDir: options.publicDir });
      if (options.scheduler !== false) {
        scheduler = createScheduler(infra, {
          driver: worker?.driver,
          onKeysRotated: () => auth.refreshKeys(),
          pushMirror: (marketplaceId) => createPluginServices(infra).mirror.push(marketplaceId),
          refreshUpstreamToken: async (principalId, installationId) => {
            const installation = await createInstallationLookup(infra).get(installationId);
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
        const draining = worker?.stop(25_000).catch(() => undefined);
        await draining;
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

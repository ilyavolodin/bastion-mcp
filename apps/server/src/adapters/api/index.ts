/**
 * Assembles `ApiDeps` (packages/api/src/ports) from the persistence adapters, the identity services and the
 * domain ports of the catalog, installation, plugin and registry areas.
 */
import type { ApiDeps } from '@bastion-mcp/api';
import { newId } from '@bastion-mcp/core';
import type {
  AuthServices,
  GuardService,
  LimitService,
  PolicyService,
  WorkerServices,
} from '../../contracts';
import type { Infra } from '../../infra';
import { authRedis } from '../redis';
import { createUpstreamAccess } from '../upstream-access';
import { createCatalogApiPorts } from './catalog';
import { createEventBus, type RedisEventBus } from './events';
import { createGuardApiPorts } from './guards';
import { createIdentityPorts } from './identity';
import { createInstallationApiPorts } from './installations';
import { createAuditReader, createCallReader } from './observability';
import { createPluginApiPorts } from './plugins';
import { createRegistryApiPorts } from './registry';
import { createSecretsPort } from './secrets';
import { createSystemStatus } from './system';
import { createApiPersistence } from './unit-of-work';

export type ApiBuild = { deps: ApiDeps; events: RedisEventBus; close(): Promise<void> };

export const buildApiDeps = async (
  infra: Infra,
  auth: AuthServices,
  parts: {
    worker: WorkerServices | undefined;
    policy: PolicyService;
    guards: GuardService;
    limits: LimitService;
  },
): Promise<ApiBuild> => {
  const { worker, policy, guards, limits } = parts;
  const persistence = await createApiPersistence(infra);
  const events = createEventBus({
    redis: infra.redis,
    duplicate: infra.duplicateRedis,
    onError: (message) => infra.logger.warn({ message }, 'event bus handler failed'),
  });
  await events.start();
  const access = createUpstreamAccess(infra, auth, worker);
  const obs = { prisma: infra.db.prisma, repos: infra.repos };

  const deps: ApiDeps = {
    config: { baseUrl: infra.config.publicUrl },
    auth: { tokens: auth.verifier, sessions: auth.sessions },
    principals: auth.principalStore,
    policy: { engine: () => policy.engine(), data: policy.data },
    store: persistence.store,
    uow: persistence.uow,
    redis: authRedis(infra.redis),
    publisher: persistence.publisher,
    events,
    pats: auth.pats,
    deactivation: auth.deactivation,
    secrets: createSecretsPort(infra.vault),
    identity: createIdentityPorts(infra),
    system: createSystemStatus(infra, {
      driverState: async () =>
        worker ? worker.driverState() : { name: 'none', healthy: true, detail: 'ui-only replica' },
    }),
    catalog: createCatalogApiPorts(infra, auth, { worker, guards, events, access }),
    installations: createInstallationApiPorts(infra, auth, { worker, policy, access }),
    registry: createRegistryApiPorts(infra),
    guards: createGuardApiPorts(infra, guards),
    observability: { calls: createCallReader(obs), audit: createAuditReader(obs) },
    plugins: createPluginApiPorts(infra),
    limits: limits.limiter,
    clock: { now: () => new Date() },
    newId,
  };
  return { deps, events, close: () => events.close() };
};

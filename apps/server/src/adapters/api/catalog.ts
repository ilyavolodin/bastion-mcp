import type { ApiDeps, EventBus } from '@bastion-mcp/api';
import { createVersionResolver } from '@bastion-mcp/registry';
import type { AuthServices, GuardService, WorkerServices } from '../../contracts';
import type { Infra } from '../../infra';
import { createPluginImportPort } from '../plugin-import';
import { createUpstreamAccess, type UpstreamAccess } from '../upstream-access';
import { createVersionTestPort } from '../version-test';

export type CatalogPortsContext = {
  /** Present when this process hosts a worker (`BASTION_ROLE=all`). */
  worker?: WorkerServices | undefined;
  guards: GuardService;
  events: EventBus;
  /** Shared with `createInstallationApiPorts` so both use one RPC client; created from `worker` when absent. */
  access?: UpstreamAccess | undefined;
};

/**
 * `ApiDeps['catalog']`: the TEST flow (11.2/11.3), zip and git imports (25.3), exact-version resolution for client
 * config imports (11.3, `BASTION_NPM_REGISTRY` and `BASTION_PYPI_INDEX_URL`) and blob storage.
 */
export const createCatalogApiPorts = (
  infra: Infra,
  auth: AuthServices,
  ctx: CatalogPortsContext,
): ApiDeps['catalog'] => {
  const access = ctx.access ?? createUpstreamAccess(infra, auth, ctx.worker);
  const fetchFn = infra.options.fetch;
  return {
    tests: createVersionTestPort(infra, {
      access,
      guards: ctx.guards,
      events: ctx.events,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    }),
    imports: createPluginImportPort(infra),
    versions: createVersionResolver({
      npmRegistry: infra.config.npmRegistry,
      pypiIndexUrl: infra.config.pypiIndexUrl,
      ...(fetchFn ? { fetch: fetchFn as never } : {}),
    }),
    blobs: infra.repos.blobs,
  };
};

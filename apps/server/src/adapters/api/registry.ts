import type { ApiDeps } from '@bastion-mcp/api';
import { createRegistryServerStore } from '@bastion-mcp/db';
import {
  type RegistryServerStore,
  type RegistrySource,
  type SecretResolver,
  type ServerJson,
  serverJsonSchema,
  syncSource,
  systemClock,
} from '@bastion-mcp/registry';
import type { Infra } from '../../infra';

/** `registry_servers` rows typed with `ServerJson` (the db default parser keeps them as plain objects). */
export const createServerStore = (infra: Infra): RegistryServerStore =>
  createRegistryServerStore<ServerJson>(infra.db.prisma, {
    parseServerJson: (raw) => serverJsonSchema.parse(raw) as ServerJson,
  }) as unknown as RegistryServerStore;

/** Resolves the auth header secret of a registry source (`registry_sources.auth_secret_id`, 11.6). */
export const createRegistrySecretResolver = (infra: Infra): SecretResolver => ({
  async resolve(secretId) {
    return (await infra.secretStore.revealById(secretId)) ?? undefined;
  },
});

/**
 * Registry ports for the API (11.6, 11.7): the db stores, plus `sync`, which the "sync now" route and the scheduler's
 * per-source job both use. The fetch is `infra.options.fetch` (tests point it at a fake registry); the base URL guard
 * resolves hosts through DNS unless `resolveHost` is injected.
 */
export const createRegistryApiPorts = (infra: Infra): ApiDeps['registry'] => {
  const servers = createServerStore(infra);
  const secrets = createRegistrySecretResolver(infra);
  const fetchFn = infra.options.fetch;
  return {
    sources: infra.repos.registrySources,
    servers,
    requests: infra.repos.installRequests,
    sync: (source: RegistrySource, options) =>
      syncSource(
        source,
        {
          serverStore: servers,
          sourceStore: infra.repos.registrySources,
          secrets,
          clock: systemClock,
          ...(fetchFn ? { fetch: fetchFn } : {}),
        },
        { full: options.full === true },
      ),
    ...(fetchFn ? { fetch: fetchFn } : {}),
  };
};

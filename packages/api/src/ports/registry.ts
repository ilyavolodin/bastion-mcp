import type { FetchFn } from '@bastion-mcp/core';
import type {
  InstallRequestStore,
  RegistryServerStore,
  RegistrySource,
  RegistrySourceStore,
  ResolveHost,
  SyncResult,
} from '@bastion-mcp/registry';

export type RegistryPorts = {
  sources: RegistrySourceStore;
  servers: RegistryServerStore;
  requests: InstallRequestStore;
  /** Starts a sync of one source now (11.6); the job runner owns scheduling. */
  sync(source: RegistrySource, options: { full?: boolean }): Promise<SyncResult>;
  /** Host resolver for the base URL guard (8.8); defaults to DNS. */
  resolveHost?: ResolveHost;
  /** Fetch used by the OSV gate (injectable in tests). */
  fetch?: FetchFn;
};

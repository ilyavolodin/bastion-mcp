import type { FetchFn } from '@bastion-mcp/core';
import type { RegistryEntry, ServerJson, ServerStatus } from './server-json';

/**
 * Ports (CONTRIBUTING rule 6). `@bastion-mcp/db` and `apps/server` implement them; this package never
 * touches a database, a secret store or a clock directly.
 */

export type { FetchFn };

export type RegistryTrust = 'official' | 'internal' | 'community';
export const REGISTRY_TRUST_LEVELS = ['official', 'internal', 'community'] as const;

/** `last_sync` jsonb on `registry_sources` (16.2). */
export type SyncStats = {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  full: boolean;
  pages: number;
  fetched: number;
  upserted: number;
  invalid: number;
  deleted: number;
  deprecated: number;
  error?: string;
  /** When the last successful full walk finished; carried forward by failed and incremental syncs. */
  lastFullAt?: string;
};

/** A row of `registry_sources` (16.2). */
export type RegistrySource = {
  id: string;
  name: string;
  baseUrl: string;
  authSecretId?: string | null;
  /** Header the secret is sent in; defaults to `Authorization`. */
  authHeaderName?: string | null;
  trust: RegistryTrust;
  enabled: boolean;
  syncIntervalS: number;
  lastUpdatedSince: Date | null;
  lastSync: SyncStats | null;
};

/** A row of `registry_servers` (16.2). `searchDocument` feeds `to_tsvector` in the adapter. */
export type RegistryServerRow = {
  sourceId: string;
  name: string;
  version: string;
  serverJson: ServerJson;
  status: ServerStatus;
  publishedAt: Date | null;
  isLatest: boolean;
  meta: Record<string, unknown>;
  searchDocument: string;
};

export type RegistrySearchQuery = {
  q?: string;
  sourceId?: string;
  /** Latest versions only (default true). */
  latestOnly?: boolean;
  /** `deleted` rows are hidden unless asked for (11.6). */
  includeDeleted?: boolean;
  limit: number;
  cursor?: string | undefined;
};

export type RegistryServerStore = {
  /** Idempotent on `(sourceId, name, version)`. */
  upsert(rows: readonly RegistryServerRow[]): Promise<void>;
  list(sourceId: string, options?: { name?: string }): Promise<RegistryServerRow[]>;
  search(query: RegistrySearchQuery): Promise<{ items: RegistryServerRow[]; nextCursor?: string }>;
};

export type RegistrySourceStore = {
  get(id: string): Promise<RegistrySource | null>;
  list(): Promise<RegistrySource[]>;
  save(source: RegistrySource): Promise<void>;
  remove(id: string): Promise<void>;
  /** Persists `last_sync`; `lastUpdatedSince` is passed only when it advances. */
  recordSync(
    id: string,
    result: { lastSync: SyncStats; lastUpdatedSince?: Date | undefined },
  ): Promise<void>;
};

export type InstallRequestStatus = 'open' | 'approved' | 'rejected' | 'cancelled';

/** A row of `install_requests` (16.2). */
export type InstallRequest = {
  id: string;
  requesterId: string;
  sourceId: string;
  serverName: string;
  version: string;
  justification: string | null;
  status: InstallRequestStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
};

export type InstallRequestStore = {
  create(request: InstallRequest): Promise<void>;
  get(id: string): Promise<InstallRequest | null>;
  /** Optimistic: adapters update only while the stored status is `open`. */
  save(request: InstallRequest): Promise<void>;
  list(filter?: { requesterId?: string; status?: InstallRequestStatus }): Promise<InstallRequest[]>;
};

/** Resolves a stored secret (for example a registry auth header) to its plaintext. */
export type SecretResolver = {
  resolve(secretId: string): Promise<string | undefined>;
};

export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

export type { RegistryEntry };

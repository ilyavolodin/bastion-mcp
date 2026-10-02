import { createClientForSource, type RegistryClient } from './client';
import type {
  Clock,
  FetchFn,
  RegistryServerRow,
  RegistryServerStore,
  RegistrySource,
  RegistrySourceStore,
  SecretResolver,
  SyncStats,
} from './ports';
import {
  REGISTRY_PUBLISHER_META,
  type RegistryEntry,
  type ServerJson,
  type ServerStatus,
} from './server-json';

/** Registry sync (11.6, 21.3). */

export const FULL_RESYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** `updated_since` is moved back by this much so entries published during a walk are never missed. */
export const UPDATED_SINCE_OVERLAP_MS = 60_000;

// --- Pure helpers ---------------------------------------------------------------------------------------------------

/** True when an enabled source has never synced or its interval has elapsed since the last attempt. */
export const isSyncDue = (
  source: Pick<RegistrySource, 'enabled' | 'syncIntervalS' | 'lastSync'>,
  now: Date,
): boolean => {
  if (!source.enabled) return false;
  if (!source.lastSync) return true;
  const last = Date.parse(source.lastSync.finishedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= source.syncIntervalS * 1000;
};

/** The weekly full re-sync (11.6): due when no full walk succeeded in the last 7 days. */
export const isFullResyncDue = (source: Pick<RegistrySource, 'lastSync'>, now: Date): boolean => {
  const lastFull = source.lastSync?.lastFullAt
    ? Date.parse(source.lastSync.lastFullAt)
    : Number.NaN;
  if (Number.isNaN(lastFull)) return true;
  return now.getTime() - lastFull >= FULL_RESYNC_INTERVAL_MS;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Text for the `search` tsvector: name (also split into words), title, description, tags and package
 * identifiers. The adapter wraps it in `to_tsvector('simple', ...)`.
 */
export const buildSearchDocument = (serverJson: ServerJson): string => {
  const parts: string[] = [serverJson.name, serverJson.name.split(/[./_-]+/).join(' ')];
  if (serverJson.title) parts.push(serverJson.title);
  if (serverJson.description) parts.push(serverJson.description);
  const publisher = serverJson._meta?.[REGISTRY_PUBLISHER_META];
  const tagSources = [
    (serverJson as Record<string, unknown>).tags,
    publisher && typeof publisher === 'object'
      ? (publisher as Record<string, unknown>).tags
      : undefined,
  ];
  for (const source of tagSources) parts.push(...stringArray(source));
  for (const pkg of serverJson.packages ?? []) parts.push(pkg.identifier);
  return parts.filter((p) => p.length > 0).join(' ');
};

export const toServerRow = (sourceId: string, entry: RegistryEntry): RegistryServerRow => ({
  sourceId,
  name: entry.name,
  version: entry.version,
  serverJson: entry.serverJson,
  status: entry.status,
  publishedAt: entry.publishedAt,
  isLatest: entry.isLatest,
  meta: entry.meta,
  searchDocument: buildSearchDocument(entry.serverJson),
});

// --- Sync -----------------------------------------------------------------------------------------------------------

export type SyncDeps = {
  serverStore: RegistryServerStore;
  sourceStore: RegistrySourceStore;
  secrets: SecretResolver;
  clock: Clock;
  fetch?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Test seam: bypasses client construction. */
  client?: RegistryClient;
};

export type SyncOptions = {
  /** Force a full re-sync (no `updated_since`). */
  full?: boolean;
  signal?: AbortSignal;
};

export type SyncResult = {
  ok: boolean;
  stats: SyncStats;
  /** Names whose mirrored status is now `deleted`: the caller hides them and flags imported catalog entries. */
  deletedNames: string[];
  /** Names whose mirrored status is now `deprecated`: the caller shows a badge. */
  deprecatedNames: string[];
  error?: string;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

/**
 * Walks the registry and mirrors it. Never throws for registry failures: mirrored data stays intact, the
 * failure lands in `last_sync` and `last_updated_since` is advanced only after a complete walk (21.3).
 */
export const syncSource = async (
  source: RegistrySource,
  deps: SyncDeps,
  options: SyncOptions = {},
): Promise<SyncResult> => {
  const started = deps.clock.now();
  const full = options.full === true || isFullResyncDue(source, started);
  const updatedSince = full ? undefined : (source.lastUpdatedSince ?? undefined);
  const deleted = new Set<string>();
  const deprecated = new Set<string>();
  const stats: SyncStats = {
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    ok: false,
    full,
    pages: 0,
    fetched: 0,
    upserted: 0,
    invalid: 0,
    deleted: 0,
    deprecated: 0,
    ...(source.lastSync?.lastFullAt ? { lastFullAt: source.lastSync.lastFullAt } : {}),
  };
  const track = (status: ServerStatus, name: string): void => {
    if (status === 'deleted') deleted.add(name);
    else if (status === 'deprecated') deprecated.add(name);
  };

  let failure: string | undefined;
  try {
    const client = deps.client ?? (await createClientForSource(source, deps));
    for await (const page of client.listServers({
      limit: 100,
      updatedSince,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      stats.pages += 1;
      stats.fetched += page.entries.length;
      stats.invalid += page.invalid;
      if (page.entries.length > 0) {
        await deps.serverStore.upsert(page.entries.map((e) => toServerRow(source.id, e)));
        stats.upserted += page.entries.length;
        for (const e of page.entries) track(e.status, e.name);
      }
    }
  } catch (error) {
    failure = errorMessage(error);
  }

  const finished = deps.clock.now();
  stats.finishedAt = finished.toISOString();
  stats.deleted = deleted.size;
  stats.deprecated = deprecated.size;
  stats.ok = failure === undefined;
  if (failure !== undefined) stats.error = failure;
  else if (full) stats.lastFullAt = finished.toISOString();

  const nextSince = stats.ok ? new Date(started.getTime() - UPDATED_SINCE_OVERLAP_MS) : undefined;
  await deps.sourceStore.recordSync(source.id, {
    lastSync: stats,
    lastUpdatedSince: nextSince,
  });

  return {
    ok: stats.ok,
    stats,
    deletedNames: [...deleted],
    deprecatedNames: [...deprecated],
    ...(failure !== undefined ? { error: failure } : {}),
  };
};

/** Listing, pagination and snapshots (7.5, 6.7). Pure functions; I/O stays in the adapters. */
import {
  canonicalDigest,
  canonicalJson,
  MAX_LIST_ITEMS_PER_INSTALLATION,
  META_KEYS,
  paginate,
  TIMEOUTS_MS,
} from '@bastion-mcp/core';
import type { EffectiveEndpoint, ItemKind, UpstreamItems } from './types';

export const DEFAULT_LIST_TTL_MS = 60_000;
export const DEFAULT_PAGE_SIZE = 1000;

export type ListPageOptions = {
  pageSize?: number | undefined;
  cursor?: string | undefined;
};

/** One page of a merged list (7.5): our own cursors, `bcur1.` + {offset, endpointHash}. */
export const paginateList = <T>(
  items: readonly T[],
  options: { pageSize?: number | undefined; endpointHash: string; cursor?: string | undefined },
): { items: T[]; nextCursor?: string } =>
  paginate(items, {
    pageSize: Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE),
    endpointHash: options.endpointHash,
    cursor: options.cursor,
  });

/** Caps an upstream list at 10,000 items (7.5); reports whether it cut. */
export const capList = <T>(list: readonly T[]): { items: T[]; truncated: boolean } =>
  list.length > MAX_LIST_ITEMS_PER_INSTALLATION
    ? { items: list.slice(0, MAX_LIST_ITEMS_PER_INSTALLATION), truncated: true }
    : { items: [...list], truncated: false };

/** `ttlMs` is the minimum upstream value (default 60,000), and results are always private (6.7). */
export const mergedTtlMs = (ttls: ReadonlyArray<number | undefined>): number => {
  const values = ttls.filter((t): t is number => typeof t === 'number' && t >= 0);
  return values.length === 0 ? DEFAULT_LIST_TTL_MS : Math.min(...values);
};

export type ListResultMeta = {
  ttlMs: number;
  cacheScope: 'private';
  _meta?: Record<string, unknown>;
};

/** `_meta` markers for skipped and unauthenticated installations (7.5, 6.9). */
export const listMeta = (
  endpoint: Pick<EffectiveEndpoint, 'degraded' | 'needsAuth'>,
): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  if (endpoint.degraded.length > 0) meta[META_KEYS.degraded] = endpoint.degraded;
  if (endpoint.needsAuth.length > 0) meta[META_KEYS.needsAuth] = endpoint.needsAuth;
  return meta;
};

const LIST_KEY = {
  tool: 'tools',
  prompt: 'prompts',
  resource: 'resources',
  resourceTemplate: 'resourceTemplates',
} as const;

/** The full `*\/list` result for a page: items, cursor, ttl, scope and degraded markers (7.5, 6.7, 6.9). */
export const listResult = (
  endpoint: EffectiveEndpoint,
  kind: ItemKind,
  options: ListPageOptions & { meta?: Record<string, unknown> } = {},
): Record<string, unknown> => {
  const list: readonly unknown[] = endpoint[LIST_KEY[kind]];
  const page = paginateList(list, {
    pageSize: options.pageSize,
    cursor: options.cursor,
    endpointHash: endpoint.hash,
  });
  const result: Record<string, unknown> = {
    [LIST_KEY[kind]]: page.items,
    ttlMs: endpoint.ttlMs,
    cacheScope: endpoint.cacheScope,
  };
  if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
  const meta = { ...(options.meta ?? {}), ...listMeta(endpoint) };
  if (Object.keys(meta).length > 0) result._meta = meta;
  return result;
};

// --- snapshot selection -----------------------------------------------------------------------------

export type ListSourceChoice =
  | { source: 'cache' }
  | { source: 'live' }
  | { source: 'snapshot' }
  | { source: 'reference' }
  | { source: 'start'; waitMs: number; onTimeout: 'degraded' };

/**
 * Where a list comes from (7.2, 7.5): the cache, the running instance, the latest snapshot, the catalog
 * reference snapshot (same `configHash`), and only with none of those a cold start that waits up to 20 s.
 * Listing never starts a sandbox when a snapshot exists.
 */
export const chooseListSource = (state: {
  cache: boolean;
  instanceRunning: boolean;
  snapshot: boolean;
  referenceSnapshot: boolean;
}): ListSourceChoice => {
  if (state.cache) return { source: 'cache' };
  if (state.instanceRunning) return { source: 'live' };
  if (state.snapshot) return { source: 'snapshot' };
  if (state.referenceSnapshot) return { source: 'reference' };
  return { source: 'start', waitMs: TIMEOUTS_MS.instanceListWait, onTimeout: 'degraded' };
};

/** Snapshot key part: covers the catalog version, arguments and non-secret variables (7.5). */
export const computeConfigHash = (input: {
  catalogVersionId: string;
  arguments?: unknown;
  variables?: Record<string, unknown>;
}): string =>
  canonicalDigest({
    catalogVersionId: input.catalogVersionId,
    arguments: input.arguments ?? null,
    variables: input.variables ?? {},
  }).toString('hex');

export type SnapshotDiff = Record<ItemKind, boolean> & { changed: boolean };

const sortedDigest = (list: readonly unknown[]): string =>
  canonicalJson(list.map((item) => canonicalJson(item)).sort());

/** Decides when to emit `list_changed` after a re-list (7.5). No previous snapshot counts as changed. */
export const diffSnapshots = (
  previous:
    | Pick<UpstreamItems, 'tools' | 'prompts' | 'resources' | 'resourceTemplates'>
    | undefined,
  next: Pick<UpstreamItems, 'tools' | 'prompts' | 'resources' | 'resourceTemplates'>,
): SnapshotDiff => {
  const differs = (key: keyof typeof next): boolean =>
    previous === undefined
      ? next[key].length > 0
      : sortedDigest(previous[key]) !== sortedDigest(next[key]);
  const diff = {
    tool: differs('tools'),
    prompt: differs('prompts'),
    resource: differs('resources'),
    resourceTemplate: differs('resourceTemplates'),
  };
  return { ...diff, changed: Object.values(diff).some(Boolean) };
};

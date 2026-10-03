/** The per-endpoint URI index (7.4): Exact, Seen, Template and Rewritten routing for `resources/read`. */
import { BastionError, JSONRPC_CODES, redisKeys } from '@bastion-mcp/core';
import {
  type HostedRead,
  mapResourceRead,
  matchUriTemplate,
  parseUriPrefix,
  type ResourceRoute,
} from '@bastion-mcp/overrides';
import { z } from 'zod';

export type UriTarget = {
  installationId: string;
  upstreamUri: string;
  /** Bastion answers this read itself (12.2 `added`). */
  hosted?: HostedRead;
};

export type UriIndex = {
  /** Advertised URI (after any `bastion+slug:` prefix) to its owner. */
  exact: Map<string, UriTarget & { route: ResourceRoute }>;
  /** URIs named by a tool's `_meta.ui.resourceUri`. */
  seen: Map<string, string>;
  templates: Array<{ installationId: string; advertised: string; route: ResourceRoute }>;
  /** `uriPrefix` installations: effective slug to installation id. */
  rewritten: Map<string, string>;
};

export type UriIndexInput = {
  /** In endpoint (priority) order: the first installation listing a URI owns it. */
  resources: Array<{
    installationId: string;
    advertisedUri: string;
    upstreamUri: string;
    route: ResourceRoute;
  }>;
  templates: Array<{ installationId: string; advertised: string; route: ResourceRoute }>;
  seen: Array<{ installationId: string; uri: string }>;
  rewritten: Array<{ slug: string; installationId: string }>;
};

export type UriConflict = { uri: string; owner: string; hidden: string };

export const buildUriIndex = (
  input: UriIndexInput,
): { index: UriIndex; conflicts: UriConflict[]; hiddenKeys: Set<string> } => {
  const index: UriIndex = {
    exact: new Map(),
    seen: new Map(),
    templates: [...input.templates],
    rewritten: new Map(input.rewritten.map((r) => [r.slug, r.installationId])),
  };
  const conflicts: UriConflict[] = [];
  /** `${installationId}\0${advertisedUri}` of losing duplicates, so the lister can drop them. */
  const hiddenKeys = new Set<string>();
  for (const r of input.resources) {
    const owner = index.exact.get(r.advertisedUri);
    if (owner) {
      if (owner.installationId !== r.installationId) {
        conflicts.push({
          uri: r.advertisedUri,
          owner: owner.installationId,
          hidden: r.installationId,
        });
        hiddenKeys.add(`${r.installationId}\0${r.advertisedUri}`);
      }
      continue;
    }
    index.exact.set(r.advertisedUri, {
      installationId: r.installationId,
      upstreamUri: r.upstreamUri,
      route: r.route,
    });
  }
  for (const s of input.seen) if (!index.seen.has(s.uri)) index.seen.set(s.uri, s.installationId);
  return { index, conflicts, hiddenKeys };
};

export type ResolvedUri = { ok: true; target: UriTarget } | { ok: false };

/** Resolves a URI in the order Exact, Seen, Template, Rewritten (7.4). A miss is `-32602`. */
export const resolveResourceUri = (index: UriIndex, uri: string): ResolvedUri => {
  const exact = index.exact.get(uri);
  if (exact) {
    const mapped = mapResourceRead(uri, exact.route);
    return mapped.ok
      ? {
          ok: true,
          target: {
            installationId: exact.installationId,
            upstreamUri: mapped.uri,
            ...(exact.route.hosted ? { hosted: exact.route.hosted } : {}),
          },
        }
      : { ok: false };
  }
  const seen = index.seen.get(uri);
  if (seen !== undefined) return { ok: true, target: { installationId: seen, upstreamUri: uri } };
  for (const t of index.templates) {
    if (matchUriTemplate(t.advertised, uri) === null) continue;
    const mapped = mapResourceRead(uri, t.route);
    if (mapped.ok) {
      return {
        ok: true,
        target: {
          installationId: t.installationId,
          upstreamUri: mapped.uri,
          ...(t.route.hosted ? { hosted: t.route.hosted } : {}),
        },
      };
    }
    return { ok: false };
  }
  const prefixed = parseUriPrefix(uri);
  if (prefixed) {
    const installationId = index.rewritten.get(prefixed.slug);
    if (installationId !== undefined) {
      return { ok: true, target: { installationId, upstreamUri: prefixed.uri } };
    }
  }
  return { ok: false };
};

/** `-32602` resource not found (6.9, 7.4). Hidden and nonexistent are indistinguishable. */
export class ResourceNotFoundError extends BastionError {
  constructor(uri: string) {
    super('RESOURCE_NOT_FOUND', `Resource not found: ${uri}`, {
      httpStatus: 404,
      mcpCode: JSONRPC_CODES.INVALID_PARAMS,
      data: { uri },
    });
  }
}

// --- Seen URIs (7.4) ------------------------------------------------------------------------------

export const SEEN_TTL_SECONDS = 24 * 60 * 60;

/** Port for the Redis hash `uriseen:{principalId}:{endpointId}`. */
export interface SeenUriStore {
  record(
    principalId: string,
    endpointId: string,
    entries: ReadonlyArray<{ uri: string; installationId: string }>,
  ): Promise<void>;
  lookup(principalId: string, endpointId: string, uri: string): Promise<string | null>;
}

export class InMemorySeenUriStore implements SeenUriStore {
  private readonly data = new Map<string, Map<string, string>>();

  async record(
    principalId: string,
    endpointId: string,
    entries: ReadonlyArray<{ uri: string; installationId: string }>,
  ): Promise<void> {
    const key = redisKeys.uriSeen(principalId, endpointId);
    const hash = this.data.get(key) ?? new Map<string, string>();
    for (const e of entries) hash.set(e.uri, e.installationId);
    this.data.set(key, hash);
  }

  async lookup(principalId: string, endpointId: string, uri: string): Promise<string | null> {
    return this.data.get(redisKeys.uriSeen(principalId, endpointId))?.get(uri) ?? null;
  }
}

/** The slice of a Redis client the adapter needs. */
export interface SeenRedis {
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
}

const redisValue = z.string().min(1).nullable();

export class RedisSeenUriStore implements SeenUriStore {
  constructor(private readonly redis: SeenRedis) {}

  async record(
    principalId: string,
    endpointId: string,
    entries: ReadonlyArray<{ uri: string; installationId: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const key = redisKeys.uriSeen(principalId, endpointId);
    const values: Record<string, string> = {};
    for (const e of entries) values[e.uri] = e.installationId;
    await this.redis.hset(key, values);
    await this.redis.expire(key, SEEN_TTL_SECONDS);
  }

  async lookup(principalId: string, endpointId: string, uri: string): Promise<string | null> {
    const raw = await this.redis.hget(redisKeys.uriSeen(principalId, endpointId), uri);
    const parsed = redisValue.safeParse(raw ?? null);
    return parsed.success ? parsed.data : null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** URIs in a tool result (`resource_link`, embedded `resource`) and `_meta.ui.resourceUri` (7.4, 6.8). */
export const extractSeenUris = (result: unknown): string[] => {
  const out = new Set<string>();
  if (!isRecord(result)) return [];
  const meta = result._meta;
  if (isRecord(meta) && isRecord(meta.ui) && typeof meta.ui.resourceUri === 'string') {
    out.add(meta.ui.resourceUri);
  }
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'resource_link' && typeof block.uri === 'string') out.add(block.uri);
      if (block.type === 'resource' && isRecord(block.resource)) {
        if (typeof block.resource.uri === 'string') out.add(block.resource.uri);
      }
    }
  }
  return [...out];
};

/** Resolves a URI, falling back to the Redis "seen" set (7.4). */
export const resolveResourceUriWithSeen = async (
  index: UriIndex,
  uri: string,
  seen: { store: SeenUriStore; principalId: string; endpointId: string },
): Promise<ResolvedUri> => {
  const sync = resolveResourceUri(index, uri);
  if (sync.ok) return sync;
  const installationId = await seen.store.lookup(seen.principalId, seen.endpointId, uri);
  return installationId === null
    ? { ok: false }
    : { ok: true, target: { installationId, upstreamUri: uri } };
};

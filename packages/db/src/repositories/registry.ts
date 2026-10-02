import { REQUEST_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import { Prisma } from '../generated/client';
import {
  type AuditContext,
  afterIdDesc,
  ConflictError,
  clampLimit,
  compact,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  idCursorOf,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  orConflict,
  type Paged,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  toJsonOrNull,
  toPage,
} from './support';

// --- registry_sources (11.6) ---------------------------------------------------------------------------------------------

export const REGISTRY_TRUST_LEVELS = ['official', 'internal', 'community'] as const;
export const SERVER_STATUSES = ['active', 'deprecated', 'deleted'] as const;

const syncStatsSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  ok: z.boolean(),
  full: z.boolean(),
  pages: z.number(),
  fetched: z.number(),
  upserted: z.number(),
  invalid: z.number(),
  deleted: z.number(),
  deprecated: z.number(),
  error: z.string().optional(),
  lastFullAt: z.string().optional(),
});
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
  lastFullAt?: string;
};

const parseSyncStats = (raw: unknown): SyncStats => compact<SyncStats>(syncStatsSchema.parse(raw));

/** `RegistrySource` of `@bastion-mcp/registry`. */
export type RegistrySourceRecord = {
  id: string;
  name: string;
  baseUrl: string;
  authSecretId?: string | null;
  authHeaderName?: string | null;
  trust: (typeof REGISTRY_TRUST_LEVELS)[number];
  enabled: boolean;
  syncIntervalS: number;
  lastUpdatedSince: Date | null;
  lastSync: SyncStats | null;
};

const trustSchema = z.enum(REGISTRY_TRUST_LEVELS);

const toSource = (row: {
  id: string;
  name: string;
  baseUrl: string;
  authSecretId: string | null;
  authHeaderName: string | null;
  trust: string;
  enabled: boolean;
  syncIntervalS: number;
  lastUpdatedSince: Date | null;
  lastSync: unknown;
}): RegistrySourceRecord => ({
  id: row.id,
  name: row.name,
  baseUrl: row.baseUrl,
  authSecretId: row.authSecretId,
  authHeaderName: row.authHeaderName,
  trust: trustSchema.parse(row.trust),
  enabled: row.enabled,
  syncIntervalS: row.syncIntervalS,
  lastUpdatedSince: row.lastUpdatedSince,
  lastSync: row.lastSync === null ? null : parseSyncStats(row.lastSync),
});

/** `RegistrySourceStore`. */
export const createRegistrySourceStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<RegistrySourceRecord | null> {
      const row = await db.registrySource.findUnique({ where: { id } });
      return row ? toSource(row) : null;
    },
    async list(): Promise<RegistrySourceRecord[]> {
      const rows = await db.registrySource.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
      return rows.map(toSource);
    },
    /** Upsert by id; a duplicate `base_url` is a 409. Does not touch sync state. */
    save(source: RegistrySourceRecord, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const existing = await tx.registrySource.findUnique({ where: { id: source.id } });
        const data = {
          name: source.name,
          baseUrl: source.baseUrl,
          authSecretId: source.authSecretId ?? null,
          authHeaderName: source.authHeaderName ?? null,
          trust: source.trust,
          enabled: source.enabled,
          syncIntervalS: source.syncIntervalS,
        };
        await orConflict('registry source', () =>
          existing
            ? tx.registrySource.update({ where: { id: source.id }, data })
            : tx.registrySource.create({
                data: {
                  id: source.id,
                  ...data,
                  lastUpdatedSince: source.lastUpdatedSince,
                  lastSync: toJsonOrNull(source.lastSync),
                },
              }),
        );
        unit.bump('org');
        unit.audit(audit, {
          action: existing ? 'registry.source.update' : 'registry.source.create',
          targetType: 'registry_source',
          targetId: source.id,
          diff: {
            before: existing ? { enabled: existing.enabled, trust: existing.trust } : null,
            after: { enabled: source.enabled, trust: source.trust, baseUrl: source.baseUrl },
          },
        });
      });
    },
    remove(id: string, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const existing = await tx.registrySource.findUnique({ where: { id } });
        if (!existing) throw new NotFoundError('registry source', id);
        await tx.registrySource.delete({ where: { id } });
        unit.bump('org');
        unit.audit(audit, {
          action: 'registry.source.delete',
          targetType: 'registry_source',
          targetId: id,
          diff: { before: { baseUrl: existing.baseUrl }, after: null },
        });
      });
    },
    /** Persists `last_sync`; `lastUpdatedSince` only moves when passed (the cursor advanced). */
    async recordSync(
      id: string,
      result: { lastSync: SyncStats; lastUpdatedSince?: Date | undefined },
    ): Promise<void> {
      await db.registrySource.update({
        where: { id },
        data: {
          lastSync: toJson(parseSyncStats(result.lastSync)),
          ...(result.lastUpdatedSince === undefined
            ? {}
            : { lastUpdatedSince: result.lastUpdatedSince }),
        },
      });
    },
  };
};

// --- registry_servers (11.6) ---------------------------------------------------------------------------------------------

/** `RegistryServerRow`; `searchDocument` feeds `to_tsvector` on write and is not persisted. */
export type RegistryServerRow<S extends Record<string, unknown> = Record<string, unknown>> = {
  sourceId: string;
  name: string;
  version: string;
  /** The registry `server.json`; `S` is `ServerJson` of `@bastion-mcp/registry` when a parser is injected. */
  serverJson: S;
  status: (typeof SERVER_STATUSES)[number];
  publishedAt: Date | null;
  isLatest: boolean;
  meta: Record<string, unknown>;
  searchDocument: string;
};

export type RegistrySearchQuery = {
  q?: string;
  sourceId?: string;
  latestOnly?: boolean;
  includeDeleted?: boolean;
  /** Hide rows of disabled sources (the browse screen never lists what cannot be installed). */
  enabledSourcesOnly?: boolean;
  /** Only entries that run as a remote server or as an npm or PyPI package. */
  runtime?: 'remote' | 'npm' | 'pypi';
  limit: number;
  cursor?: string | undefined;
};

const statusSchema = z.enum(SERVER_STATUSES);

type RawServer = {
  source_id: string;
  name: string;
  version: string;
  server_json: unknown;
  status: string;
  is_latest: boolean;
  published_at: Date | null;
  meta: unknown;
};

const fromRawWith = <S extends Record<string, unknown>>(
  r: RawServer,
  parse: (raw: unknown) => S,
): RegistryServerRow<S> => ({
  sourceId: r.source_id,
  name: r.name,
  version: r.version,
  serverJson: parse(r.server_json),
  status: statusSchema.parse(r.status),
  publishedAt: r.published_at,
  isLatest: r.is_latest,
  meta: jsonObjectSchema.parse(r.meta),
  searchDocument: '',
});

const COLUMNS = Prisma.sql`source_id::text AS source_id, name, version, server_json, status, is_latest, published_at, meta`;

/**
 * `RegistryServerStore`: idempotent upserts on `(source_id, name, version)` and Postgres full-text search with
 * `to_tsvector('simple', searchDocument)` (11.6). Search with `q` is ranked and pages by offset; without `q` it
 * is a keyset over `(name, source_id, version)`.
 */
export const createRegistryServerStore = <
  S extends Record<string, unknown> = Record<string, unknown>,
>(
  arg: PrismaLike | RepoContext,
  options: RepoOptions & { parseServerJson?: (raw: unknown) => S } = {},
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const parse = options.parseServerJson ?? ((raw: unknown) => jsonObjectSchema.parse(raw) as S);
  const fromRaw = (r: RawServer): RegistryServerRow<S> => fromRawWith(r, parse);
  return {
    async upsert(rows: readonly RegistryServerRow<S>[]): Promise<void> {
      if (rows.length === 0) return;
      // One statement per call instead of one per row (a registry page is 100 rows); the last duplicate wins.
      const unique = new Map<string, RegistryServerRow<S>>();
      for (const row of rows) unique.set(`${row.sourceId} ${row.name} ${row.version}`, row);
      const list = [...unique.values()];
      await mutate(ctx, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO registry_servers
            (source_id, name, version, server_json, status, is_latest, published_at, meta, search, synced_at)
          SELECT t.source_id::uuid, t.name, t.version, t.server_json::jsonb, t.status, t.is_latest,
                 t.published_at::timestamptz, t.meta::jsonb, to_tsvector('simple', t.doc), now()
          FROM unnest(
            ${list.map((r) => r.sourceId)}::text[], ${list.map((r) => r.name)}::text[],
            ${list.map((r) => r.version)}::text[], ${list.map((r) => JSON.stringify(r.serverJson))}::text[],
            ${list.map((r) => r.status)}::text[], ${list.map((r) => r.isLatest)}::boolean[],
            ${list.map((r) => (r.publishedAt ? r.publishedAt.toISOString() : null))}::text[],
            ${list.map((r) => JSON.stringify(r.meta))}::text[], ${list.map((r) => r.searchDocument)}::text[]
          ) AS t(source_id, name, version, server_json, status, is_latest, published_at, meta, doc)
          ON CONFLICT (source_id, name, version) DO UPDATE SET
            server_json = EXCLUDED.server_json, status = EXCLUDED.status, is_latest = EXCLUDED.is_latest,
            published_at = EXCLUDED.published_at, meta = EXCLUDED.meta, search = EXCLUDED.search,
            synced_at = now()`;
      });
    },

    async list(sourceId: string, opts: { name?: string } = {}): Promise<RegistryServerRow<S>[]> {
      const rows = await db.$queryRaw<RawServer[]>`
        SELECT ${COLUMNS} FROM registry_servers
        WHERE source_id = ${sourceId}::uuid
          ${opts.name === undefined ? Prisma.empty : Prisma.sql`AND name = ${opts.name}`}
        ORDER BY name ASC, version ASC`;
      return rows.map(fromRaw);
    },

    async search(
      query: RegistrySearchQuery,
    ): Promise<{ items: RegistryServerRow<S>[]; nextCursor?: string }> {
      const limit = clampLimit(query.limit);
      const filters = [
        query.sourceId === undefined
          ? Prisma.empty
          : Prisma.sql`AND source_id = ${query.sourceId}::uuid`,
        query.latestOnly === false ? Prisma.empty : Prisma.sql`AND is_latest`,
        query.includeDeleted ? Prisma.empty : Prisma.sql`AND status <> 'deleted'`,
        query.enabledSourcesOnly
          ? Prisma.sql`AND source_id IN (SELECT id FROM registry_sources WHERE enabled)`
          : Prisma.empty,
        query.runtime === undefined
          ? Prisma.empty
          : query.runtime === 'remote'
            ? Prisma.sql`AND jsonb_array_length(COALESCE(server_json->'remotes', '[]'::jsonb)) > 0`
            : Prisma.sql`AND COALESCE(server_json->'packages', '[]'::jsonb) @> ${JSON.stringify([{ registryType: query.runtime }])}::jsonb`,
      ];
      const where = Prisma.join(filters, ' ');
      const q = query.q?.trim();
      let rows: RawServer[];
      let next: string | undefined;
      if (q) {
        const offset = Number(decodeCursor(query.cursor)?.[0] ?? 0);
        if (!Number.isInteger(offset) || offset < 0) throw new InvalidCursorError();
        rows = await db.$queryRaw<RawServer[]>`
          SELECT ${COLUMNS} FROM registry_servers
          WHERE search @@ websearch_to_tsquery('simple', ${q}) ${where}
          ORDER BY ts_rank(search, websearch_to_tsquery('simple', ${q})) DESC, name ASC, source_id ASC, version DESC
          LIMIT ${limit + 1} OFFSET ${offset}`;
        if (rows.length > limit) next = encodeCursor([offset + limit]);
      } else {
        const c = decodeCursor(query.cursor);
        if (c && (c.length !== 3 || c.some((v) => typeof v !== 'string')))
          throw new InvalidCursorError();
        const after =
          c === undefined
            ? Prisma.empty
            : Prisma.sql`AND (name, source_id, version) > (${String(c[0])}, ${String(c[1])}::uuid, ${String(c[2])})`;
        rows = await db.$queryRaw<RawServer[]>`
          SELECT ${COLUMNS} FROM registry_servers
          WHERE true ${where} ${after}
          ORDER BY name ASC, source_id ASC, version ASC
          LIMIT ${limit + 1}`;
        const last = rows[limit - 1];
        if (rows.length > limit && last)
          next = encodeCursor([last.name, last.source_id, last.version]);
      }
      const items = rows.slice(0, limit).map(fromRaw);
      return next === undefined ? { items } : { items, nextCursor: next };
    },

    /** Marks versions of a source that vanished upstream as deleted (11.6); returns how many changed. */
    async markMissingDeleted(
      sourceId: string,
      seenKeys: readonly { name: string; version: string }[],
    ): Promise<number> {
      const names = seenKeys.map((k) => k.name);
      const versions = seenKeys.map((k) => k.version);
      return db.$executeRaw`
        UPDATE registry_servers SET status = 'deleted', synced_at = now()
        WHERE source_id = ${sourceId}::uuid AND status <> 'deleted'
          AND (name, version) NOT IN (SELECT * FROM unnest(${names}::text[], ${versions}::text[]))`;
    },
  };
};

// --- registry_policies (11.7) ----------------------------------------------------------------------------------------------

/** One JSON policy per source; the shape is owned by `@bastion-mcp/registry` (`RegistryPolicy`). */
export const createRegistryPolicyStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(sourceId: string): Promise<Record<string, unknown> | null> {
      const row = await db.registryPolicy.findUnique({ where: { sourceId } });
      return row ? jsonObjectSchema.parse(row.policy) : null;
    },
    set(sourceId: string, policy: Record<string, unknown>, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const before = await tx.registryPolicy.findUnique({ where: { sourceId } });
        await tx.registryPolicy.upsert({
          where: { sourceId },
          create: { sourceId, policy: toJson(policy) },
          update: { policy: toJson(policy), updatedAt: new Date() },
        });
        unit.bump('org');
        unit.audit(audit, {
          action: 'registry.policy.set',
          targetType: 'registry_source',
          targetId: sourceId,
          diff: { before: before?.policy ?? null, after: policy },
        });
      });
    },
  };
};

// --- install_requests (11.7) -------------------------------------------------------------------------------------------------

export type InstallRequestStatus = (typeof REQUEST_STATUSES)[number];

/** `InstallRequest` of `@bastion-mcp/registry`. */
export type InstallRequestRecord = {
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

const requestStatus = z.enum(REQUEST_STATUSES);

const toRequest = (row: {
  id: string;
  requesterId: string;
  sourceId: string;
  serverName: string;
  version: string;
  justification: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
}): InstallRequestRecord => ({ ...row, status: requestStatus.parse(row.status) });

/** `InstallRequestStore`: `save` only updates while the stored status is `open` (409 otherwise). */
export const createInstallRequestStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    create(request: InstallRequestRecord, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        await tx.installRequest.create({ data: request });
        unit.audit(audit, {
          action: 'install_request.create',
          targetType: 'install_request',
          targetId: request.id,
          diff: {
            before: null,
            after: { serverName: request.serverName, version: request.version },
          },
        });
      });
    },
    async get(id: string): Promise<InstallRequestRecord | null> {
      const row = await db.installRequest.findUnique({ where: { id } });
      return row ? toRequest(row) : null;
    },
    save(request: InstallRequestRecord, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.installRequest.updateMany({
          where: { id: request.id, status: 'open' },
          data: {
            status: request.status,
            decidedBy: request.decidedBy,
            decidedAt: request.decidedAt,
            reason: request.reason,
            justification: request.justification,
          },
        });
        if (res.count === 0) {
          const exists = await tx.installRequest.count({ where: { id: request.id } });
          if (exists === 0) throw new NotFoundError('install request', request.id);
          throw new ConflictError('install request was already decided', { id: request.id });
        }
        unit.audit(audit, {
          action: `install_request.${request.status}`,
          targetType: 'install_request',
          targetId: request.id,
          diff: {
            before: { status: 'open' },
            after: { status: request.status, reason: request.reason },
          },
        });
      });
    },
    async list(
      filter: { requesterId?: string; status?: InstallRequestStatus } = {},
    ): Promise<InstallRequestRecord[]> {
      const rows = await db.installRequest.findMany({
        where: {
          ...(filter.requesterId ? { requesterId: filter.requesterId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
        orderBy: { id: 'desc' },
      });
      return rows.map(toRequest);
    },
    async listPage(
      filter: {
        requesterId?: string;
        status?: InstallRequestStatus;
        limit?: number;
        cursor?: string;
      } = {},
    ): Promise<Paged<InstallRequestRecord>> {
      const limit = clampLimit(filter.limit);
      const rows = await db.installRequest.findMany({
        where: {
          ...(filter.requesterId ? { requesterId: filter.requesterId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...afterIdDesc(filter.cursor),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = toPage(rows, limit, idCursorOf);
      return { items: page.items.map(toRequest), nextCursor: page.nextCursor };
    },
  };
};

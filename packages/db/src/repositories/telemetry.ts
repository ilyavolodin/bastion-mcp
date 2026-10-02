import { type CALL_OUTCOMES, newId, type PRINCIPAL_TYPES } from '@bastion-mcp/core';
import { NIL_UUID } from '../config-version';
import { Prisma } from '../generated/client';
import {
  FINITE_BOUNDS_MS,
  LATENCY_BUCKET_COUNT,
  mergeBuckets,
  percentileFromBuckets,
} from '../latency';
import { dropPartitionsBefore, ensurePartitions, type PartitionedTable } from '../partitions';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  type Paged,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJsonOrNull,
  ValidationError,
} from './support';

// --- partition-aware inserts ------------------------------------------------------------------------------------------

/** Runs an insert; when Postgres has no partition for the timestamp, creates today+7 days and retries once. */
export const withPartitionRetry = async <T>(
  db: PrismaLike,
  table: PartitionedTable,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (!/no partition of relation/i.test(String(error))) throw error;
    await ensurePartitions(db, table, 7);
    return fn();
  }
};

// --- call_log: write side (15.5) ---------------------------------------------------------------------------------------

/** `CallLogRow` of `@bastion-mcp/telemetry` (`z.infer` of `callLogRowSchema`). */
export type CallLogRow = {
  id: string;
  ts: Date;
  durationMs: number;
  principalType: (typeof PRINCIPAL_TYPES)[number];
  principalId: string;
  clientId?: string | null | undefined;
  clientName?: string | null | undefined;
  endpointId?: string | null | undefined;
  installationId?: string | null | undefined;
  catalogEntryId?: string | null | undefined;
  catalogVersionId?: string | null | undefined;
  method: string;
  itemName?: string | null | undefined;
  upstreamName?: string | null | undefined;
  outcome: (typeof CALL_OUTCOMES)[number];
  errorCode?: string | null | undefined;
  jsonrpcCode?: number | null | undefined;
  eraDown: string;
  eraUp?: string | null | undefined;
  coldStart: boolean;
  bytesIn: number;
  bytesOut: number;
  guardResults?: unknown;
  policyReasons?: unknown;
  argsPreview?: unknown;
  resultPreview?: unknown;
  traceId?: string | null | undefined;
  spanId?: string | null | undefined;
};

const INSERT_CHUNK = 1000;

const rowData = (r: CallLogRow): Prisma.CallLogCreateManyInput => ({
  id: r.id,
  ts: r.ts,
  durationMs: r.durationMs,
  principalType: r.principalType,
  principalId: r.principalId,
  clientId: r.clientId ?? null,
  clientName: r.clientName ?? null,
  endpointId: r.endpointId ?? null,
  installationId: r.installationId ?? null,
  catalogEntryId: r.catalogEntryId ?? null,
  catalogVersionId: r.catalogVersionId ?? null,
  method: r.method,
  itemName: r.itemName ?? null,
  upstreamName: r.upstreamName ?? null,
  outcome: r.outcome,
  errorCode: r.errorCode ?? null,
  jsonrpcCode: r.jsonrpcCode ?? null,
  eraDown: r.eraDown,
  eraUp: r.eraUp ?? null,
  coldStart: r.coldStart,
  bytesIn: r.bytesIn,
  bytesOut: r.bytesOut,
  guardResults: toJsonOrNull(r.guardResults),
  policyReasons: toJsonOrNull(r.policyReasons),
  argsPreview: toJsonOrNull(r.argsPreview),
  resultPreview: toJsonOrNull(r.resultPreview),
  traceId: r.traceId ?? null,
  spanId: r.spanId ?? null,
});

// --- call_log: read side ---------------------------------------------------------------------------------------------------

export type CallSummary = {
  id: string;
  ts: Date;
  durationMs: number;
  principalType: string;
  principalId: string;
  clientId: string | null;
  clientName: string | null;
  endpointId: string | null;
  installationId: string | null;
  catalogEntryId: string | null;
  catalogVersionId: string | null;
  method: string;
  itemName: string | null;
  upstreamName: string | null;
  outcome: string;
  errorCode: string | null;
  jsonrpcCode: number | null;
  eraDown: string;
  eraUp: string | null;
  coldStart: boolean;
  bytesIn: number;
  bytesOut: number;
  traceId: string | null;
  spanId: string | null;
};

export type CallDetail = CallSummary & {
  guardResults: unknown;
  policyReasons: unknown;
  argsPreview: unknown;
  resultPreview: unknown;
};

export type CallListFilter = {
  /** The calling user or service account. */
  principalId?: string;
  /** Calls of any member of these teams (manager visibility, 10.1). */
  teamIds?: readonly string[];
  installationId?: string;
  catalogEntryId?: string;
  endpointId?: string;
  clientId?: string;
  method?: string;
  itemName?: string;
  outcome?: (typeof CALL_OUTCOMES)[number] | readonly (typeof CALL_OUTCOMES)[number][];
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
};

const SUMMARY_SELECT = {
  id: true,
  ts: true,
  durationMs: true,
  principalType: true,
  principalId: true,
  clientId: true,
  clientName: true,
  endpointId: true,
  installationId: true,
  catalogEntryId: true,
  catalogVersionId: true,
  method: true,
  itemName: true,
  upstreamName: true,
  outcome: true,
  errorCode: true,
  jsonrpcCode: true,
  eraDown: true,
  eraUp: true,
  coldStart: true,
  bytesIn: true,
  bytesOut: true,
  traceId: true,
  spanId: true,
} as const;

const callCursor = (cursor: string | undefined): { ts: Date; id: string } | undefined => {
  const c = decodeCursor(cursor);
  if (!c) return undefined;
  const [ts, id] = c;
  if (typeof ts !== 'number' || typeof id !== 'string') throw new InvalidCursorError();
  return { ts: new Date(ts), id };
};

// --- rollups (15.5) ----------------------------------------------------------------------------------------------------------

export type StatsTier = 'minute' | 'hour' | 'day';

const TIER_SECONDS: Record<StatsTier, number> = { minute: 60, hour: 3600, day: 86_400 };
const TIER_TABLE: Record<StatsTier, string> = {
  minute: 'call_stats_minute',
  hour: 'call_stats_hour',
  day: 'call_stats_day',
};
const TIER_SOURCE: Record<Exclude<StatsTier, 'minute'>, StatsTier> = {
  hour: 'minute',
  day: 'hour',
};
/** Rows are recomputed this far behind the newest rolled bucket so late call-log rows still land (15.5). */
const DEFAULT_LOOKBACK_BUCKETS: Record<StatsTier, number> = { minute: 10, hour: 3, day: 2 };
const MAX_CATCHUP_MS = 7 * 86_400_000;

/** Minute 7 days, hour 90 days, day 2 years (15.5). */
export const STATS_RETENTION_DAYS: Record<StatsTier, number> = { minute: 7, hour: 90, day: 730 };

export type RollupResult = { tier: StatsTier; from: Date; to: Date; buckets: number };

const floorTo = (d: Date, seconds: number): Date =>
  new Date(Math.floor(d.getTime() / (seconds * 1000)) * seconds * 1000);

const tierBucketSql = (seconds: number, column: Prisma.Sql) =>
  Prisma.sql`to_timestamp(floor(extract(epoch FROM ${column}) / ${seconds}) * ${seconds})`;

export type StatsQuery = {
  from: Date;
  to: Date;
  tier?: StatsTier;
  groupBy?: readonly ('time' | 'installation' | 'catalogEntry' | 'item' | 'outcome')[];
  installationId?: string;
  catalogEntryId?: string;
  itemName?: string;
  outcome?: string;
  /** Reference time for choosing a tier; defaults to now. */
  now?: Date;
};

export type StatsRow = {
  bucket?: Date;
  installationId?: string | null;
  catalogEntryId?: string | null;
  itemName?: string;
  outcome?: string;
  count: number;
  errorCount: number;
  bytesOut: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  latencyBuckets: number[];
};

const GROUP_COLUMNS = {
  time: 'bucket',
  installation: 'installation_id',
  catalogEntry: 'catalog_entry_id',
  item: 'item_name',
  outcome: 'outcome',
} as const;

/** The finest tier that still holds the range and keeps the bucket count reasonable (15.5 retention). */
export const chooseTier = (from: Date, to: Date, now: Date = new Date()): StatsTier => {
  const rangeMs = to.getTime() - from.getTime();
  const ageMs = now.getTime() - from.getTime();
  const day = 86_400_000;
  if (rangeMs <= 6 * 3_600_000 && ageMs <= STATS_RETENTION_DAYS.minute * day) return 'minute';
  if (rangeMs <= 60 * day && ageMs <= STATS_RETENTION_DAYS.hour * day) return 'hour';
  return 'day';
};

const numberOf = (v: bigint | number | null): number => (v === null ? 0 : Number(v));

export type RetentionPolicy = {
  /** `logs.retentionDays`: call_log, egress_events and distribution_events partitions older than this go. */
  logsRetentionDays: number;
};

/**
 * Call log writes and reads, rollups and retention (15.5). `insertBatch` is the `CallLogSink` of
 * `@bastion-mcp/telemetry`; the rollup jobs are meant for the scheduler (one replica at a time through
 * graphile-worker, but they are idempotent and safe to repeat).
 */
export const createCallLogRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);

  const insertBatch = async (rows: readonly CallLogRow[]): Promise<void> => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const data = rows.slice(i, i + INSERT_CHUNK).map(rowData);
      // `skipDuplicates` makes a retry after a lost acknowledgement harmless (primary key `(ts, id)`).
      await withPartitionRetry(db, 'call_log', () =>
        db.callLog.createMany({ data, skipDuplicates: true }),
      );
    }
  };

  const watermark = async (tier: StatsTier): Promise<Date | null> => {
    const rows = await db.$queryRaw<{ max: Date | null }[]>`
      SELECT max(bucket) AS max FROM ${Prisma.raw(TIER_TABLE[tier])}`;
    return rows[0]?.max ?? null;
  };

  const windowFor = async (
    tier: StatsTier,
    now: Date,
    lookback: number,
  ): Promise<{ from: Date; to: Date } | null> => {
    const seconds = TIER_SECONDS[tier];
    const to = floorTo(now, seconds);
    const wm = await watermark(tier);
    const earliest = new Date(now.getTime() - MAX_CATCHUP_MS);
    let from: Date;
    if (wm) {
      from = new Date(wm.getTime() - lookback * seconds * 1000);
    } else {
      const src = tier === 'minute' ? null : TIER_SOURCE[tier];
      const rows =
        src === null
          ? await db.$queryRaw<{ min: Date | null }[]>`
              SELECT min(ts) AS min FROM call_log WHERE ts >= ${earliest}`
          : await db.$queryRaw<{ min: Date | null }[]>`
              SELECT min(bucket) AS min FROM ${Prisma.raw(TIER_TABLE[src])}`;
      const first = rows[0]?.min;
      if (!first) return null;
      from = floorTo(first, seconds);
    }
    from = floorTo(
      from.getTime() < earliest.getTime() && tier === 'minute' ? earliest : from,
      seconds,
    );
    return from.getTime() >= to.getTime() ? null : { from, to };
  };

  /**
   * Aggregates finished minutes of `call_log` into `call_stats_minute` (`rollupMinuteJob`). Recomputes from a few
   * minutes before the newest rolled bucket, so the job is idempotent and tolerates late rows.
   */
  const rollupMinuteJob = async (
    now: Date = new Date(),
    opts: { lookbackBuckets?: number } = {},
  ): Promise<RollupResult> => {
    const win = await windowFor(
      'minute',
      now,
      opts.lookbackBuckets ?? DEFAULT_LOOKBACK_BUCKETS.minute,
    );
    if (!win) return { tier: 'minute', from: floorTo(now, 60), to: floorTo(now, 60), buckets: 0 };
    const buckets = await db.$executeRaw`
      WITH src AS (
        SELECT ${tierBucketSql(60, Prisma.sql`ts`)} AS bucket,
               COALESCE(installation_id, ${NIL_UUID}::uuid) AS installation_id,
               catalog_entry_id,
               COALESCE(item_name, '') AS item_name,
               outcome, bytes_out,
               (SELECT count(*) FROM unnest(${[...FINITE_BOUNDS_MS]}::float8[]) AS b(v) WHERE b.v < duration_ms)::int AS bi
        FROM call_log WHERE ts >= ${win.from} AND ts < ${win.to}
      ), agg AS (
        SELECT bucket, installation_id, item_name, outcome,
               count(*)::int AS cnt,
               (count(*) FILTER (WHERE outcome NOT IN ('ok', 'input_required')))::int AS error_count,
               COALESCE(sum(bytes_out), 0)::bigint AS bytes_out,
               (array_agg(catalog_entry_id) FILTER (WHERE catalog_entry_id IS NOT NULL))[1] AS catalog_entry_id
        FROM src GROUP BY bucket, installation_id, item_name, outcome
      ), hist AS (
        SELECT bucket, installation_id, item_name, outcome, bi, count(*)::int AS c
        FROM src GROUP BY bucket, installation_id, item_name, outcome, bi
      )
      INSERT INTO call_stats_minute
        (bucket, installation_id, catalog_entry_id, item_name, outcome, "count", error_count, bytes_out, latency_buckets)
      SELECT a.bucket, a.installation_id, a.catalog_entry_id, a.item_name, a.outcome, a.cnt, a.error_count, a.bytes_out,
             ARRAY(
               SELECT COALESCE(h.c, 0)::int
               FROM generate_series(0, ${LATENCY_BUCKET_COUNT - 1}) AS g(bi)
               LEFT JOIN hist h ON h.bucket = a.bucket AND h.installation_id = a.installation_id
                 AND h.item_name = a.item_name AND h.outcome = a.outcome AND h.bi = g.bi
               ORDER BY g.bi)
      FROM agg a
      ON CONFLICT (bucket, installation_id, item_name, outcome) DO UPDATE SET
        catalog_entry_id = EXCLUDED.catalog_entry_id, "count" = EXCLUDED."count",
        error_count = EXCLUDED.error_count, bytes_out = EXCLUDED.bytes_out,
        latency_buckets = EXCLUDED.latency_buckets`;
    return { tier: 'minute', ...win, buckets };
  };

  /** Finished hours (from the minute table) or days (from the hour table); same idempotent recompute window. */
  const rollupUpJob = async (
    tier: 'hour' | 'day',
    now: Date = new Date(),
    opts: { lookbackBuckets?: number } = {},
  ): Promise<RollupResult> => {
    const seconds = TIER_SECONDS[tier];
    const win = await windowFor(tier, now, opts.lookbackBuckets ?? DEFAULT_LOOKBACK_BUCKETS[tier]);
    if (!win) return { tier, from: floorTo(now, seconds), to: floorTo(now, seconds), buckets: 0 };
    const src = Prisma.raw(TIER_TABLE[TIER_SOURCE[tier]]);
    const dst = Prisma.raw(TIER_TABLE[tier]);
    const buckets = await db.$executeRaw`
      WITH src AS (
        SELECT ${tierBucketSql(seconds, Prisma.sql`bucket`)} AS hb, installation_id, item_name, outcome,
               "count", error_count, bytes_out, catalog_entry_id, latency_buckets
        FROM ${src} WHERE bucket >= ${win.from} AND bucket < ${win.to}
      ), agg AS (
        SELECT hb, installation_id, item_name, outcome,
               sum("count")::int AS cnt, sum(error_count)::int AS error_count, sum(bytes_out)::bigint AS bytes_out,
               (array_agg(catalog_entry_id) FILTER (WHERE catalog_entry_id IS NOT NULL))[1] AS catalog_entry_id
        FROM src GROUP BY hb, installation_id, item_name, outcome
      ), hist AS (
        SELECT s.hb, s.installation_id, s.item_name, s.outcome, u.ord, sum(u.val)::int AS v
        FROM src s, unnest(s.latency_buckets) WITH ORDINALITY AS u(val, ord)
        GROUP BY s.hb, s.installation_id, s.item_name, s.outcome, u.ord
      )
      INSERT INTO ${dst}
        (bucket, installation_id, catalog_entry_id, item_name, outcome, "count", error_count, bytes_out, latency_buckets)
      SELECT a.hb, a.installation_id, a.catalog_entry_id, a.item_name, a.outcome, a.cnt, a.error_count, a.bytes_out,
             ARRAY(
               SELECT COALESCE(h.v, 0)::int
               FROM generate_series(1, ${LATENCY_BUCKET_COUNT}) AS g(ord)
               LEFT JOIN hist h ON h.hb = a.hb AND h.installation_id = a.installation_id
                 AND h.item_name = a.item_name AND h.outcome = a.outcome AND h.ord = g.ord
               ORDER BY g.ord)
      FROM agg a
      ON CONFLICT (bucket, installation_id, item_name, outcome) DO UPDATE SET
        catalog_entry_id = EXCLUDED.catalog_entry_id, "count" = EXCLUDED."count",
        error_count = EXCLUDED.error_count, bytes_out = EXCLUDED.bytes_out,
        latency_buckets = EXCLUDED.latency_buckets`;
    return { tier, ...win, buckets };
  };

  return {
    /** `CallLogSink` of `@bastion-mcp/telemetry`: one batch insert per 1000 rows into the daily partitions. */
    insertBatch,

    async list(filter: CallListFilter = {}): Promise<Paged<CallSummary>> {
      const limit = clampLimit(filter.limit);
      const cursor = callCursor(filter.cursor);
      let principalIds: string[] | undefined;
      if (filter.teamIds) {
        const members = await db.teamMembership.findMany({
          where: { teamId: { in: [...filter.teamIds] } },
          select: { userId: true },
        });
        principalIds = [...new Set(members.map((m) => m.userId))];
        if (filter.principalId) principalIds = principalIds.filter((p) => p === filter.principalId);
      }
      const outcomes = filter.outcome === undefined ? undefined : [filter.outcome].flat();
      const rows = await db.callLog.findMany({
        where: {
          AND: [
            principalIds
              ? { principalId: { in: principalIds } }
              : filter.principalId
                ? { principalId: filter.principalId }
                : {},
            filter.installationId ? { installationId: filter.installationId } : {},
            filter.catalogEntryId ? { catalogEntryId: filter.catalogEntryId } : {},
            filter.endpointId ? { endpointId: filter.endpointId } : {},
            filter.clientId ? { clientId: filter.clientId } : {},
            filter.method ? { method: filter.method } : {},
            filter.itemName ? { itemName: filter.itemName } : {},
            outcomes ? { outcome: { in: outcomes } } : {},
            filter.from || filter.to
              ? {
                  ts: {
                    ...(filter.from ? { gte: filter.from } : {}),
                    ...(filter.to ? { lt: filter.to } : {}),
                  },
                }
              : {},
            cursor
              ? { OR: [{ ts: { lt: cursor.ts } }, { ts: cursor.ts, id: { lt: cursor.id } }] }
              : {},
          ],
        },
        select: SUMMARY_SELECT,
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor([last.ts.getTime(), last.id]) : null,
      };
    },

    /** One call with previews and guard/policy details; pass `ts` to read a single partition. */
    async get(id: string, hint: { ts?: Date } = {}): Promise<CallDetail | null> {
      const row = await db.callLog.findFirst({
        where: { id, ...(hint.ts ? { ts: hint.ts } : {}) },
      });
      if (!row) return null;
      const { guardResults, policyReasons, argsPreview, resultPreview, ...summary } = row;
      return { ...summary, guardResults, policyReasons, argsPreview, resultPreview };
    },

    rollupMinuteJob,
    rollupHourJob: (now?: Date, opts?: { lookbackBuckets?: number }) =>
      rollupUpJob('hour', now, opts),
    rollupDayJob: (now?: Date, opts?: { lookbackBuckets?: number }) =>
      rollupUpJob('day', now, opts),

    /** Minute, then hour, then day: the scheduler's per-minute entry point. */
    async rollupAll(now: Date = new Date()): Promise<RollupResult[]> {
      return [
        await rollupMinuteJob(now),
        await rollupUpJob('hour', now),
        await rollupUpJob('day', now),
      ];
    },

    /**
     * Dashboard statistics from the rollup tables only (15.5). Percentiles come from the merged latency buckets.
     * The tier defaults to the finest one that holds the range.
     */
    async stats(query: StatsQuery): Promise<{ tier: StatsTier; rows: StatsRow[] }> {
      if (query.to.getTime() <= query.from.getTime()) throw new ValidationError('empty time range');
      const tier = query.tier ?? chooseTier(query.from, query.to, query.now);
      const groups = [...new Set(query.groupBy ?? [])];
      const cols = groups.map((g) => GROUP_COLUMNS[g]);
      const table = Prisma.raw(TIER_TABLE[tier]);
      const filters = [
        Prisma.sql`bucket >= ${query.from} AND bucket < ${query.to}`,
        query.installationId
          ? Prisma.sql`AND installation_id = ${query.installationId}::uuid`
          : Prisma.empty,
        query.catalogEntryId
          ? Prisma.sql`AND catalog_entry_id = ${query.catalogEntryId}::uuid`
          : Prisma.empty,
        query.itemName === undefined ? Prisma.empty : Prisma.sql`AND item_name = ${query.itemName}`,
        query.outcome === undefined ? Prisma.empty : Prisma.sql`AND outcome = ${query.outcome}`,
      ];
      const where = Prisma.join(filters, ' ');
      const colList =
        cols.length === 0
          ? Prisma.sql`1 AS g`
          : Prisma.join(
              cols.map((c) => Prisma.raw(c)),
              ', ',
            );
      const groupList =
        cols.length === 0
          ? Prisma.sql`g`
          : Prisma.join(
              cols.map((c) => Prisma.raw(c)),
              ', ',
            );
      const joinOn =
        cols.length === 0
          ? Prisma.sql`h.g = a.g`
          : Prisma.join(
              cols.map(
                (c) => Prisma.sql`h.${Prisma.raw(c)} IS NOT DISTINCT FROM a.${Prisma.raw(c)}`,
              ),
              ' AND ',
            );
      const selectA =
        cols.length === 0
          ? Prisma.empty
          : Prisma.sql`${Prisma.join(
              cols.map((c) => Prisma.sql`a.${Prisma.raw(c)}`),
              ', ',
            )},`;
      type Raw = Record<string, unknown> & {
        cnt: number;
        err: number;
        bytes: bigint | null;
        lat: number[];
      };
      const raw = await db.$queryRaw<Raw[]>`
        WITH base AS (
          SELECT bucket, installation_id, catalog_entry_id, item_name, outcome, "count", error_count, bytes_out, latency_buckets
          FROM ${table} WHERE ${where}
        ), a AS (
          SELECT ${colList}, sum("count")::int AS cnt, sum(error_count)::int AS err, sum(bytes_out)::bigint AS bytes
          FROM base GROUP BY ${groupList}
        ), h AS (
          SELECT ${colList}, u.ord, sum(u.val)::int AS v
          FROM base, unnest(latency_buckets) WITH ORDINALITY AS u(val, ord)
          GROUP BY ${groupList}, u.ord
        )
        SELECT ${selectA} a.cnt, a.err, a.bytes,
               ARRAY(
                 SELECT COALESCE(h.v, 0)::int FROM generate_series(1, ${LATENCY_BUCKET_COUNT}) AS g2(ord)
                 LEFT JOIN h ON ${joinOn} AND h.ord = g2.ord ORDER BY g2.ord) AS lat
        FROM a
        ORDER BY ${groupList}`;
      const rows = raw.map((r): StatsRow => {
        const lat = mergeBuckets(r.lat, []);
        const row: StatsRow = {
          count: r.cnt,
          errorCount: r.err,
          bytesOut: numberOf(r.bytes),
          p50: percentileFromBuckets(lat, 0.5),
          p95: percentileFromBuckets(lat, 0.95),
          p99: percentileFromBuckets(lat, 0.99),
          latencyBuckets: lat,
        };
        if (groups.includes('time')) row.bucket = r.bucket as Date;
        if (groups.includes('installation')) {
          row.installationId =
            r.installation_id === NIL_UUID ? null : (r.installation_id as string);
        }
        if (groups.includes('catalogEntry')) {
          row.catalogEntryId =
            r.catalog_entry_id === NIL_UUID
              ? null
              : ((r.catalog_entry_id as string | null) ?? null);
        }
        if (groups.includes('item')) row.itemName = r.item_name as string;
        if (groups.includes('outcome')) row.outcome = r.outcome as string;
        return row;
      });
      return { tier, rows };
    },

    /** Drops stats rows past their retention and whole partitions past `logs.retentionDays` (15.5). */
    async applyRetention(
      now: Date,
      policy: RetentionPolicy,
    ): Promise<{
      statsRows: Record<StatsTier, number>;
      partitions: Record<PartitionedTable, number>;
    }> {
      const day = 86_400_000;
      const statsRows: Record<StatsTier, number> = { minute: 0, hour: 0, day: 0 };
      statsRows.minute = (
        await db.callStatsMinute.deleteMany({
          where: { bucket: { lt: new Date(now.getTime() - STATS_RETENTION_DAYS.minute * day) } },
        })
      ).count;
      statsRows.hour = (
        await db.callStatsHour.deleteMany({
          where: { bucket: { lt: new Date(now.getTime() - STATS_RETENTION_DAYS.hour * day) } },
        })
      ).count;
      statsRows.day = (
        await db.callStatsDay.deleteMany({
          where: { bucket: { lt: new Date(now.getTime() - STATS_RETENTION_DAYS.day * day) } },
        })
      ).count;
      const cutoff = new Date(now.getTime() - policy.logsRetentionDays * day);
      const partitions = {
        call_log: await dropPartitionsBefore(db, 'call_log', cutoff),
        egress_events: await dropPartitionsBefore(db, 'egress_events', cutoff),
        distribution_events: await dropPartitionsBefore(db, 'distribution_events', cutoff),
      };
      return { statsRows, partitions };
    },

    /** Creates the daily partitions the scheduler keeps 7 days ahead (15.5). */
    async ensurePartitionsAhead(daysAhead = 7): Promise<void> {
      for (const table of ['call_log', 'egress_events', 'distribution_events'] as const) {
        await ensurePartitions(db, table, daysAhead);
      }
    },
  };
};

// --- egress_events (8.8) -------------------------------------------------------------------------------------------------------

/** `EgressAuditEvent` of `@bastion-mcp/sandbox`. */
export type EgressAuditEvent = {
  instanceId: string;
  protocol: string;
  host: string;
  port: number;
  resolvedIp: string | null;
  decision: 'allow' | 'deny';
  reason?: string;
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
  /** Epoch milliseconds. */
  ts: number;
};

export type EgressEventView = {
  id: string;
  ts: Date;
  instanceId: string;
  host: string;
  port: number;
  ip: string | null;
  decision: string;
  protocol: string | null;
  reason: string | null;
  bytesUp: number | null;
  bytesDown: number | null;
  durationMs: number | null;
};

/** `EgressAuditSink` over `egress_events`, plus the read side of the installation page (denials first). */
export const createEgressEventRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  return {
    /** Never throws into the proxy path callers care about: errors propagate so the sink can count them. */
    async record(event: EgressAuditEvent): Promise<void> {
      await withPartitionRetry(db, 'egress_events', () =>
        db.egressEvent.create({
          data: {
            id: newId(),
            ts: new Date(event.ts),
            instanceId: event.instanceId,
            host: event.host,
            port: event.port,
            ip: event.resolvedIp,
            decision: event.decision,
            protocol: event.protocol,
            reason: event.reason ?? null,
            bytesUp: BigInt(Math.max(0, Math.trunc(event.bytesUp))),
            bytesDown: BigInt(Math.max(0, Math.trunc(event.bytesDown))),
            durationMs: Math.max(0, Math.trunc(event.durationMs)),
          },
        }),
      );
    },

    /** Events of one instance or of every instance of an installation, newest first. */
    async list(filter: {
      instanceId?: string;
      installationId?: string;
      decision?: 'allow' | 'deny';
      from?: Date;
      to?: Date;
      limit?: number;
      cursor?: string;
    }): Promise<Paged<EgressEventView>> {
      const limit = clampLimit(filter.limit);
      const cursor = callCursor(filter.cursor);
      let instanceIds: string[] | undefined;
      if (filter.installationId) {
        instanceIds = (
          await db.instance.findMany({
            where: { installationId: filter.installationId },
            select: { id: true },
          })
        ).map((i) => i.id);
        if (filter.instanceId) instanceIds = instanceIds.filter((i) => i === filter.instanceId);
      }
      const rows = await db.egressEvent.findMany({
        where: {
          AND: [
            instanceIds
              ? { instanceId: { in: instanceIds } }
              : filter.instanceId
                ? { instanceId: filter.instanceId }
                : {},
            filter.decision ? { decision: filter.decision } : {},
            filter.from || filter.to
              ? {
                  ts: {
                    ...(filter.from ? { gte: filter.from } : {}),
                    ...(filter.to ? { lt: filter.to } : {}),
                  },
                }
              : {},
            cursor
              ? { OR: [{ ts: { lt: cursor.ts } }, { ts: cursor.ts, id: { lt: cursor.id } }] }
              : {},
          ],
        },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(
        (r): EgressEventView => ({
          ...r,
          bytesUp: r.bytesUp === null ? null : Number(r.bytesUp),
          bytesDown: r.bytesDown === null ? null : Number(r.bytesDown),
        }),
      );
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor([last.ts.getTime(), last.id]) : null,
      };
    },
  };
};

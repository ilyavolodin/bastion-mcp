/**
 * `CallReader` and `AuditReader` of the control-plane API over the call-log, rollup and audit repositories
 * (15.5, 15.6, 17.2). Dashboards read the rollup tables only; `?team=` statistics and guard/sandbox/findings views
 * are computed from the raw tables because the rollups carry no principal or guard detail.
 */
import type {
  AuditEventView,
  AuditReader,
  AuditVerifyResult,
  CallFilter,
  CallReader,
  CallRecord,
  FindingRecord,
  Page,
  StatsQuery,
  StatsSeries,
} from '@bastion-mcp/api';
import { CALL_OUTCOMES, type Clock, MS, systemClock } from '@bastion-mcp/core';
import {
  decodeCursor,
  encodeCursor,
  Prisma,
  type PrismaClient,
  type Repositories,
} from '@bastion-mcp/db';

type Tier = 'minute' | 'hour' | 'day';

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

const outcomeOf = (value: string | undefined): (typeof CALL_OUTCOMES)[number] | undefined =>
  CALL_OUTCOMES.find((o) => o === value);

const toCallRecord = (
  row: Record<string, unknown> & { id: string; ts: Date; principalId: string },
): CallRecord => ({
  // Undefined values would fail the loose response schema; they mean "not selected".
  ...(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as typeof row),
  // The list view does not select the detail columns; the record shape always carries the keys (null when absent).
  guardResults: row.guardResults ?? null,
  policyReasons: row.policyReasons ?? null,
  argsPreview: row.argsPreview ?? null,
  resultPreview: row.resultPreview ?? null,
  id: row.id,
  ts: row.ts.toISOString(),
  userId: row.principalId,
});

const rangeOf = (q: StatsQuery, now: Date): { from: Date; to: Date } => {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - MS.DAY);
  return { from, to };
};

const tierFor = (q: StatsQuery, from: Date, to: Date): Tier => {
  if (q.bucket) return q.bucket;
  const span = to.getTime() - from.getTime();
  return span <= 6 * MS.HOUR ? 'minute' : span <= 60 * MS.DAY ? 'hour' : 'day';
};

const GROUPS = {
  installation: 'installation',
  installationId: 'installation',
  catalogEntry: 'catalogEntry',
  catalogEntryId: 'catalogEntry',
  item: 'item',
  itemName: 'item',
  outcome: 'outcome',
  user: 'user',
  userId: 'user',
} as const;
type Group = (typeof GROUPS)[keyof typeof GROUPS];

const groupOf = (value: string | undefined): Group | undefined =>
  value === undefined ? undefined : (GROUPS as Record<string, Group>)[value];

export type ObservabilityDeps = {
  prisma: PrismaClient;
  repos: Pick<Repositories, 'callLog' | 'auditLog'>;
  /** Time source for default ranges; the system clock when absent. */
  clock?: Clock;
};

export const createCallReader = ({
  prisma,
  repos,
  clock = systemClock,
}: ObservabilityDeps): CallReader => {
  const nowDate = (): Date => new Date(clock.now());
  const rollupSeries = async (
    q: StatsQuery,
    pick: (row: {
      count: number;
      errorCount: number;
      bytesOut: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    }) => Record<string, number>,
  ): Promise<StatsSeries> => {
    const { from, to } = rangeOf(q, nowDate());
    if (to.getTime() <= from.getTime()) return { buckets: [] };
    const tier = tierFor(q, from, to);
    const asked = groupOf(q.groupBy);
    // The rollups carry no person: a grouping by person is answered from the call log (`logSeries`), never here.
    const group = asked === 'user' ? undefined : asked;
    const { rows } = await repos.callLog.stats({
      from,
      to,
      tier,
      groupBy: group ? ['time', group] : ['time'],
    });
    return {
      buckets: rows.map((r) => ({
        ts: (r.bucket ?? from).toISOString(),
        group:
          group === 'installation'
            ? (r.installationId ?? null)
            : group === 'catalogEntry'
              ? (r.catalogEntryId ?? null)
              : group === 'item'
                ? (r.itemName ?? null)
                : group === 'outcome'
                  ? (r.outcome ?? null)
                  : null,
        values: pick({
          count: r.count,
          errorCount: r.errorCount,
          bytesOut: r.bytesOut,
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
        }),
      })),
    };
  };

  /**
   * Statistics by team or person, or grouped by person, need the principal, so they come from `call_log` itself (the
   * rollups carry no principal).
   */
  const logSeries = async (q: StatsQuery): Promise<StatsSeries> => {
    const { from, to } = rangeOf(q, nowDate());
    const tier = tierFor(q, from, to);
    const group = groupOf(q.groupBy);
    const col =
      group === 'installation'
        ? Prisma.sql`c.installation_id::text`
        : group === 'catalogEntry'
          ? Prisma.sql`c.catalog_entry_id::text`
          : group === 'item'
            ? Prisma.sql`c.item_name`
            : group === 'outcome'
              ? Prisma.sql`c.outcome`
              : group === 'user'
                ? Prisma.sql`c.principal_id::text`
                : Prisma.sql`NULL::text`;
    const inTeam = q.teamId
      ? Prisma.sql`AND c.principal_id IN (SELECT user_id FROM team_memberships WHERE team_id = ${q.teamId}::uuid)`
      : Prisma.empty;
    const ofUser = q.userId ? Prisma.sql`AND c.principal_id = ${q.userId}::uuid` : Prisma.empty;
    const rows = await prisma.$queryRaw<
      { ts: Date; grp: string | null; n: number; err: number; bytes: bigint | null }[]
    >`
      SELECT date_trunc(${tier}, c.ts) AS ts, ${col} AS grp, count(*)::int AS n,
             count(*) FILTER (WHERE c.outcome NOT IN ('ok', 'input_required'))::int AS err,
             sum(c.bytes_out)::bigint AS bytes
      FROM call_log c
      WHERE c.ts >= ${from} AND c.ts < ${to} ${inTeam} ${ofUser}
      GROUP BY 1, 2 ORDER BY 1, 2`;
    return {
      buckets: rows.map((r) => ({
        ts: r.ts.toISOString(),
        group: r.grp,
        values: { count: r.n, errors: r.err, bytesOut: Number(r.bytes ?? 0) },
      })),
    };
  };

  return {
    async list(filter: CallFilter) {
      const outcome = outcomeOf(filter.outcome);
      const page = await repos.callLog.list({
        ...(filter.userId ? { principalId: filter.userId } : {}),
        ...(filter.teamId ? { teamIds: [filter.teamId] } : {}),
        ...(filter.installationId ? { installationId: filter.installationId } : {}),
        ...(filter.item ? { itemName: filter.item } : {}),
        ...(outcome ? { outcome } : {}),
        ...(filter.from ? { from: new Date(filter.from) } : {}),
        ...(filter.to ? { to: new Date(filter.to) } : {}),
        limit: filter.limit,
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
      });
      return { items: page.items.map(toCallRecord), nextCursor: page.nextCursor };
    },

    async get(id) {
      const row = await repos.callLog.get(id);
      return row ? toCallRecord(row) : null;
    },

    callStats: (q) =>
      q.teamId || q.userId || groupOf(q.groupBy) === 'user'
        ? logSeries(q)
        : rollupSeries(q, (r) => ({ count: r.count, errors: r.errorCount, bytesOut: r.bytesOut })),

    latency: (q) =>
      rollupSeries(q, (r) => ({
        count: r.count,
        p50: r.p50 ?? 0,
        p95: r.p95 ?? 0,
        p99: r.p99 ?? 0,
      })),

    async guardStats(q) {
      const { from, to } = rangeOf(q, nowDate());
      const tier = tierFor(q, from, to);
      const rows = await prisma.$queryRaw<
        { ts: Date; guard: string; verdict: string; n: number }[]
      >`
        SELECT date_trunc(${tier}, c.ts) AS ts, r->>'guard' AS guard, r->>'verdict' AS verdict, count(*)::int AS n
        FROM call_log c, jsonb_array_elements(c.guard_results) AS r
        WHERE c.ts >= ${from} AND c.ts < ${to}
          AND c.guard_results IS NOT NULL AND jsonb_typeof(c.guard_results) = 'array'
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
      const out = new Map<string, StatsSeries['buckets'][number]>();
      for (const r of rows) {
        const key = `${r.ts.toISOString()}|${r.guard}`;
        let bucket = out.get(key);
        if (!bucket) {
          bucket = { ts: r.ts.toISOString(), group: r.guard, values: {} };
          out.set(key, bucket);
        }
        bucket.values[r.verdict] = (bucket.values[r.verdict] ?? 0) + r.n;
      }
      return { buckets: [...out.values()] };
    },

    async sandboxStats(q) {
      const { from, to } = rangeOf(q, nowDate());
      const tier = tierFor(q, from, to);
      const rows = await prisma.$queryRaw<
        { ts: Date; grp: string; starts: number; failures: number }[]
      >`
        SELECT date_trunc(${tier}, started_at) AS ts, COALESCE(driver, kind) AS grp,
               count(*)::int AS starts, COALESCE(sum(failure_count), 0)::int AS failures
        FROM instances
        WHERE started_at >= ${from} AND started_at < ${to}
        GROUP BY 1, 2 ORDER BY 1, 2`;
      return {
        buckets: rows.map((r) => ({
          ts: r.ts.toISOString(),
          group: r.grp,
          values: { starts: r.starts, failures: r.failures },
        })),
      };
    },

    /** Guard blocks, open drift reviews and denied egress, newest first (13, 13.6, 8.8). */
    async findings(filter): Promise<Page<FindingRecord>> {
      const from = filter.from ? new Date(filter.from) : new Date(0);
      const to = filter.to ? new Date(filter.to) : new Date(clock.now() + MS.DAY);
      const cursor = decodeCursor(filter.cursor);
      const before = cursor ? new Date(Number(cursor[0])) : to;
      const beforeId = cursor ? String(cursor[1]) : 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      const rows = await prisma.$queryRaw<
        { id: string; ts: Date; kind: string; subject: string | null; detail: string | null }[]
      >`
        SELECT * FROM (
          SELECT id::text AS id, ts, 'guard_block' AS kind, principal_id::text AS subject,
                 COALESCE(item_name, method) AS detail
            FROM call_log WHERE outcome = 'blocked' AND ts >= ${from} AND ts < ${to}
          UNION ALL
          SELECT id::text, created_at, 'drift', installation_id::text, item_key
            FROM drift_reviews WHERE status = 'open' AND created_at >= ${from} AND created_at < ${to}
          UNION ALL
          SELECT id::text, ts, 'egress_denied', instance_id::text, host || ':' || port
            FROM egress_events WHERE decision = 'deny' AND ts >= ${from} AND ts < ${to}
        ) f
        WHERE (f.ts < ${before} OR (f.ts = ${before} AND f.id < ${beforeId}))
        ORDER BY f.ts DESC, f.id DESC
        LIMIT ${filter.limit + 1}`;
      const items = rows.slice(0, filter.limit).map((r) => ({
        id: r.id,
        ts: r.ts.toISOString(),
        kind: r.kind,
        subject: r.subject,
        detail: r.detail,
      }));
      const last = rows.length > filter.limit ? rows[filter.limit - 1] : undefined;
      return {
        items,
        nextCursor: last ? encodeCursor([last.ts.getTime(), last.id]) : null,
      };
    },
  };
};

// --- audit -----------------------------------------------------------------------------------------------------------------

const toAuditView = (e: {
  seq: bigint;
  id: string;
  ts: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  requestId: string | null;
}): AuditEventView => ({
  seq: e.seq.toString(),
  id: e.id,
  ts: e.ts.toISOString(),
  actorType: e.actorType,
  actorId: e.actorId,
  action: e.action,
  targetType: e.targetType,
  targetId: e.targetId,
  diff: e.diff ?? null,
  ip: e.ip,
  requestId: e.requestId,
});

export const createAuditReader = ({ prisma, repos }: ObservabilityDeps): AuditReader => ({
  async list(filter) {
    if (filter.teamId) {
      // A team's events: its own and those performed by its members (15.6).
      const members = await prisma.teamMembership.findMany({
        where: { teamId: filter.teamId },
        select: { userId: true },
      });
      const before = filter.cursor
        ? BigInt(String(decodeCursor(filter.cursor)?.[0] ?? 0))
        : undefined;
      const rows = await prisma.auditEvent.findMany({
        where: {
          AND: [
            {
              OR: [
                { actorId: { in: members.map((m) => m.userId) } },
                { targetType: 'team', targetId: filter.teamId },
              ],
            },
            filter.actorId ? { actorId: filter.actorId } : {},
            filter.action
              ? filter.action.endsWith('*')
                ? { action: { startsWith: filter.action.slice(0, -1) } }
                : { action: filter.action }
              : {},
            filter.from || filter.to
              ? {
                  ts: {
                    ...(filter.from ? { gte: new Date(filter.from) } : {}),
                    ...(filter.to ? { lt: new Date(filter.to) } : {}),
                  },
                }
              : {},
            before === undefined ? {} : { seq: { lt: before } },
          ],
        },
        orderBy: { seq: 'desc' },
        take: filter.limit + 1,
      });
      const items = rows.slice(0, filter.limit).map(toAuditView);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: rows.length > filter.limit && last ? encodeCursor([last.seq]) : null,
      };
    }
    const page = await repos.auditLog.list({
      ...(filter.actorId ? { actorId: filter.actorId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.from ? { from: new Date(filter.from) } : {}),
      ...(filter.to ? { to: new Date(filter.to) } : {}),
      limit: filter.limit,
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
    });
    return { items: page.items.map(toAuditView), nextCursor: page.nextCursor };
  },

  async *all(filter) {
    for await (const batch of repos.auditLog.export({
      ...(filter.from ? { from: new Date(filter.from) } : {}),
      ...(filter.to ? { to: new Date(filter.to) } : {}),
    })) {
      for (const event of batch) yield toAuditView(event);
    }
  },

  async verify(): Promise<AuditVerifyResult> {
    const result = await repos.auditLog.verify();
    return result.ok
      ? { ok: true, checked: result.checked }
      : { ok: false, checked: result.checked, brokenAtSeq: result.brokenAtSeq.toString() };
  },
});

export const toIso = iso;

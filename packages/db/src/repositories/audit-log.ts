import { type VerifyResult, verifyAuditChain } from '../audit';
import type { AuditEvent, Prisma } from '../generated/client';
import {
  bytesToHex,
  clampLimit,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  type Paged,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
} from './support';

/** An `audit_events` row as the API exposes it: hashes as lowercase hex, `seq` as a bigint. */
export type AuditEventView = {
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
  userAgent: string | null;
  requestId: string | null;
  prevHash: string | null;
  hash: string;
};

export type AuditFilter = {
  actorId?: string;
  actorType?: string;
  /** Exact action, or a prefix when it ends with `*` (`catalog.*`). */
  action?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  from?: Date;
  to?: Date;
};

const toView = (r: AuditEvent): AuditEventView => ({
  seq: r.seq,
  id: r.id,
  ts: r.ts,
  actorType: r.actorType,
  actorId: r.actorId,
  action: r.action,
  targetType: r.targetType,
  targetId: r.targetId,
  diff: r.diff,
  ip: r.ip,
  userAgent: r.userAgent,
  requestId: r.requestId,
  prevHash: r.prevHash === null ? null : bytesToHex(r.prevHash),
  hash: bytesToHex(r.hash),
});

const where = (f: AuditFilter): Prisma.AuditEventWhereInput => ({
  ...(f.actorId ? { actorId: f.actorId } : {}),
  ...(f.actorType ? { actorType: f.actorType } : {}),
  ...(f.action
    ? f.action.endsWith('*')
      ? { action: { startsWith: f.action.slice(0, -1) } }
      : { action: f.action }
    : {}),
  ...(f.targetType ? { targetType: f.targetType } : {}),
  ...(f.targetId ? { targetId: f.targetId } : {}),
  ...(f.requestId ? { requestId: f.requestId } : {}),
  ...(f.from || f.to
    ? { ts: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } }
    : {}),
});

const seqCursor = (cursor: string | undefined): bigint | undefined => {
  const c = decodeCursor(cursor);
  if (!c) return undefined;
  const [raw] = c;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new InvalidCursorError();
  return BigInt(raw);
};

export const EXPORT_BATCH_SIZE = 1000;

/** Reads of the hash-chained audit log (15.6): filtered pages, streaming export, verification, retention. */
export const createAuditLogRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    /** Newest first; the cursor is the `seq` of the last row. */
    async list(
      filter: AuditFilter & { limit?: number; cursor?: string } = {},
    ): Promise<Paged<AuditEventView>> {
      const limit = clampLimit(filter.limit);
      const before = seqCursor(filter.cursor);
      const rows = await db.auditEvent.findMany({
        where: { AND: [where(filter), before === undefined ? {} : { seq: { lt: before } }] },
        orderBy: { seq: 'desc' },
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(toView);
      const last = items[items.length - 1];
      return { items, nextCursor: hasMore && last ? encodeCursor([last.seq.toString()]) : null };
    },

    async get(id: string): Promise<AuditEventView | null> {
      const row = await db.auditEvent.findUnique({ where: { id } });
      return row ? toView(row) : null;
    },

    /**
     * Streams matching events oldest first in batches, for the CSV/JSON download (15.6). Rows are read by `seq`
     * keyset, so memory stays bounded and a concurrent writer never makes the stream skip or repeat rows.
     */
    async *export(
      filter: AuditFilter = {},
      batchSize = EXPORT_BATCH_SIZE,
    ): AsyncGenerator<AuditEventView[]> {
      let after: bigint | undefined;
      for (;;) {
        const rows = await db.auditEvent.findMany({
          where: { AND: [where(filter), after === undefined ? {} : { seq: { gt: after } }] },
          orderBy: { seq: 'asc' },
          take: batchSize,
        });
        if (rows.length === 0) return;
        yield rows.map(toView);
        const last = rows[rows.length - 1];
        if (!last || rows.length < batchSize) return;
        after = last.seq;
      }
    },

    /** `GET /api/v1/audit/verify`: walks the whole chain. */
    verify(): Promise<VerifyResult> {
      return verifyAuditChain(db);
    },

    /**
     * Retention (default 365 days): deletes only the oldest prefix of the chain, up to the newest row older than
     * `before`, so the remaining rows still verify (the first remaining row seeds the walk).
     */
    async pruneBefore(before: Date): Promise<number> {
      return db.$executeRaw`
        DELETE FROM audit_events
        WHERE seq <= COALESCE((SELECT max(seq) FROM audit_events WHERE ts < ${before}), 0)`;
    },
  };
};

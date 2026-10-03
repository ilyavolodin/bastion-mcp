import { canonicalJson, newId, sha256 } from '@bastion-mcp/core';
import type { DbExecutor } from './client';
import { Prisma } from './generated/client';

/** Hash chain over `audit_events` (15.6): `hash = sha256(prev_hash || canonical_row)`. */
export const GENESIS_HASH: Buffer = Buffer.alloc(32);

export type AuditFields = {
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
};

export type AuditRow = AuditFields & { seq: bigint; prevHash: Buffer | null; hash: Buffer };

export type AuditInput = {
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** The event time; defaults to the system clock. */
  now?: Date;
};

export const computeAuditHash = (prevHash: Buffer, row: AuditFields): Buffer => {
  const canonical = canonicalJson({
    id: row.id,
    ts: row.ts.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    diff: row.diff ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
  });
  return sha256(Buffer.concat([prevHash, Buffer.from(canonical)]));
};

export type VerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtSeq: bigint };

/**
 * Walks rows in sequence order and reports the first row whose link or hash does not verify.
 * `previous` seeds the walk when rows are verified page by page.
 */
export const verifyAuditRows = (
  rows: readonly AuditRow[],
  previous: Buffer | null = null,
): VerifyResult => {
  let last = previous;
  let checked = 0;
  for (const row of rows) {
    const linked = last === null ? true : (row.prevHash?.equals(last) ?? false);
    const expectedPrev = last ?? row.prevHash ?? GENESIS_HASH;
    if (!linked || !computeAuditHash(expectedPrev, row).equals(row.hash)) {
      return { ok: false, checked, brokenAtSeq: row.seq };
    }
    last = row.hash;
    checked += 1;
  }
  return { ok: true, checked };
};

const AUDIT_LOCK_KEY = 7_201_501;

/**
 * Appends one event inside the caller's transaction. A transaction-scoped advisory lock serializes
 * writers so the chain never forks; the lock releases with the transaction.
 */
export const appendAuditEvent = async (
  tx: Prisma.TransactionClient,
  input: AuditInput,
): Promise<AuditRow> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
  const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last ? Buffer.from(last.hash) : GENESIS_HASH;
  const fields: AuditFields = {
    id: newId(),
    ts: input.now ?? new Date(),
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    diff: input.diff ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
  };
  const hash = computeAuditHash(prevHash, fields);
  const stored = last ? prevHash : null;
  const created = await tx.auditEvent.create({
    data: {
      ...fields,
      diff: (fields.diff ?? Prisma.DbNull) as Prisma.InputJsonValue,
      prevHash: stored ? new Uint8Array(stored) : null,
      hash: new Uint8Array(hash),
    },
  });
  return { ...fields, seq: created.seq, prevHash: stored, hash };
};

type AuditReader = Pick<Prisma.TransactionClient, 'auditEvent'> & DbExecutor;

/** Verifies the whole chain, paging through rows (`GET /api/v1/audit/verify`). */
export const verifyAuditChain = async (db: AuditReader): Promise<VerifyResult> => {
  let cursor: bigint | undefined;
  let previous: Buffer | null = null;
  let checked = 0;
  for (;;) {
    const page = await db.auditEvent.findMany({
      orderBy: { seq: 'asc' },
      take: 1000,
      ...(cursor === undefined ? {} : { where: { seq: { gt: cursor } } }),
    });
    if (page.length === 0) return { ok: true, checked };
    const rows: AuditRow[] = page.map((r) => ({
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
      prevHash: r.prevHash ? Buffer.from(r.prevHash) : null,
      hash: Buffer.from(r.hash),
    }));
    const result = verifyAuditRows(rows, previous);
    if (!result.ok) {
      return { ok: false, checked: checked + result.checked, brokenAtSeq: result.brokenAtSeq };
    }
    checked += result.checked;
    const lastRow = rows[rows.length - 1] as AuditRow;
    previous = lastRow.hash;
    cursor = lastRow.seq;
  }
};

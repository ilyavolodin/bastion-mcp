import { describe, expect, it } from 'vitest';
import type { AuditEvent, PrismaClient } from '../src/generated/client';
import { createAuditLogRepository } from '../src/repositories/audit-log';
import { encodeCursor, InvalidCursorError } from '../src/repositories/support';

const event = (seq: number): AuditEvent => ({
  seq: BigInt(seq),
  id: `id-${seq}`,
  ts: new Date(seq * 1000),
  actorType: 'user',
  actorId: null,
  action: 'x.y',
  targetType: 'x',
  targetId: null,
  diff: null,
  ip: null,
  userAgent: null,
  requestId: null,
  prevHash: null,
  hash: Buffer.from([seq]),
});

type FindArgs = { where: unknown; orderBy: unknown; take: number };

const fakeDb = (rows: AuditEvent[]) => {
  const calls: FindArgs[] = [];
  const db = {
    $connect: () => undefined,
    $queryRaw: () => undefined,
    auditEvent: {
      findMany: async (args: FindArgs) => {
        calls.push(args);
        return rows.slice(0, args.take);
      },
    },
  } as unknown as PrismaClient;
  return { db, calls };
};

describe('15.6 audit log reads', () => {
  it('pages newest first and cursors on seq', async () => {
    const { db, calls } = fakeDb([event(5), event(4), event(3)]);
    const page = await createAuditLogRepository(db).list({ limit: 2 });
    expect(calls[0]?.take).toBe(3);
    expect(calls[0]?.orderBy).toEqual({ seq: 'desc' });
    expect(page.items.map((i) => i.seq)).toEqual([5n, 4n]);
    expect(page.items[0]?.hash).toBe('05');
    expect(page.nextCursor).toBe(encodeCursor(['4']));
  });

  it('applies the cursor as seq < last and has no next cursor on the last page', async () => {
    const { db, calls } = fakeDb([event(2)]);
    const page = await createAuditLogRepository(db).list({ limit: 5, cursor: encodeCursor(['3']) });
    expect(
      JSON.stringify(calls[0]?.where, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    ).toContain('"seq":{"lt":"3n"}');
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a cursor that is not a decimal seq', async () => {
    const { db } = fakeDb([]);
    await expect(
      createAuditLogRepository(db).list({ cursor: encodeCursor(['abc']) }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('turns an action ending in * into a prefix match', async () => {
    const { db, calls } = fakeDb([]);
    await createAuditLogRepository(db).list({ action: 'catalog.*' });
    expect(JSON.stringify(calls[0]?.where)).toContain('catalog.');
  });
});

import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  type CallLogRow,
  createCallLogRepository,
  createEgressEventRepository,
  createUserRepository,
} from '../../src/repositories';
import { encodeCursor } from '../../src/repositories/support';
import { dbEnabled, useTestDb } from '../helpers/db';

const base = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 9, 0, 0));
})();
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);

const callRow = (principalId: string, ts: Date): CallLogRow => ({
  id: newId(),
  ts,
  durationMs: 1,
  principalType: 'user',
  principalId,
  method: 'tools/call',
  outcome: 'ok',
  eraDown: 'modern',
  coldStart: false,
  bytesIn: 1,
  bytesOut: 1,
});

const decoded = (cursor: string | null): unknown =>
  cursor === null ? null : JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

describe.skipIf(!dbEnabled())('15.5 call log and egress list pagination', () => {
  const h = useTestDb();

  it('17.1 call log pages: cursor bytes, ordering, exact limit, empty and clamped limits', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const principal = newId();
    // Three rows, the two newest share a timestamp: ties order by id descending.
    const rows = [callRow(principal, at(1)), callRow(principal, at(2)), callRow(principal, at(2))];
    await repo.insertBatch(rows);
    const expected = [...rows].sort((a, b) =>
      b.ts.getTime() !== a.ts.getTime() ? b.ts.getTime() - a.ts.getTime() : a.id < b.id ? 1 : -1,
    );

    const all = await repo.list({ principalId: principal });
    expect(all.items.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(all.nextCursor).toBeNull();

    const exact = await repo.list({ principalId: principal, limit: 3 });
    expect(exact.items).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();

    const first = await repo.list({ principalId: principal, limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual(expected.slice(0, 2).map((r) => r.id));
    const keptLast = expected[1] as CallLogRow;
    expect(first.nextCursor).toBe(encodeCursor([keptLast.ts.getTime(), keptLast.id]));
    expect(decoded(first.nextCursor)).toEqual([keptLast.ts.getTime(), keptLast.id]);

    const second = await repo.list({
      principalId: principal,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((r) => r.id)).toEqual([(expected[2] as CallLogRow).id]);
    expect(second.nextCursor).toBeNull();

    const clamped = await repo.list({ principalId: principal, limit: 0 });
    expect(clamped.items).toHaveLength(1);
    expect(clamped.nextCursor).toBe(
      encodeCursor([expected[0]?.ts.getTime() ?? 0, expected[0]?.id ?? '']),
    );

    expect(await repo.list({ principalId: newId() })).toEqual({ items: [], nextCursor: null });
    expect(await repo.list({ principalId: principal, from: at(3), to: at(4) })).toEqual({
      items: [],
      nextCursor: null,
    });
    const ranged = await repo.list({ principalId: principal, from: at(2), to: at(3) });
    expect(ranged.items).toHaveLength(2);
    const upperExclusive = await repo.list({ principalId: principal, from: at(1), to: at(2) });
    expect(upperExclusive.items.map((r) => r.id)).toEqual([(rows[0] as CallLogRow).id]);
  });

  it('17.1 egress pages: cursor bytes, ordering, exact limit, empty and time range', async () => {
    const repo = createEgressEventRepository(h.db.prisma);
    const user = await createUserRepository(h.db.prisma).create({
      email: 'egress-pages@acme.com',
      displayName: 'E',
    });
    const installId = newId();
    await h.db.prisma.installation.create({
      data: {
        id: installId,
        ownerType: 'user',
        ownerId: user.id,
        slug: 'egp',
        toolPrefix: 'egp',
        displayName: 'EGP',
        origin: 'manual',
        personalSpec: { type: 'remote' },
      },
    });
    const instanceId = newId();
    await h.db.prisma.instance.create({
      data: { id: instanceId, installationId: installId, kind: 'sandbox', state: 'running' },
    });
    const event = (host: string, ts: Date) =>
      repo.record({
        instanceId,
        protocol: 'https',
        host,
        port: 443,
        resolvedIp: null,
        decision: 'allow',
        bytesUp: 1,
        bytesDown: 1,
        durationMs: 1,
        ts: ts.getTime(),
      });
    await event('a.example', at(1));
    await event('b.example', at(2));
    await event('c.example', at(2));

    const all = await repo.list({ instanceId });
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    const times = all.items.map((e) => e.ts.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const sameTs = all.items.filter((e) => e.ts.getTime() === at(2).getTime());
    expect(sameTs.map((e) => e.id)).toEqual(
      sameTs
        .map((e) => e.id)
        .sort()
        .reverse(),
    );

    expect((await repo.list({ instanceId, limit: 3 })).nextCursor).toBeNull();

    const first = await repo.list({ instanceId, limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual(all.items.slice(0, 2).map((e) => e.id));
    const keptLast = all.items[1];
    expect(first.nextCursor).toBe(encodeCursor([keptLast?.ts.getTime() ?? 0, keptLast?.id ?? '']));
    expect(decoded(first.nextCursor)).toEqual([keptLast?.ts.getTime(), keptLast?.id]);

    const second = await repo.list({
      instanceId,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((e) => e.id)).toEqual([all.items[2]?.id]);
    expect(second.nextCursor).toBeNull();

    expect(await repo.list({ instanceId: newId() })).toEqual({ items: [], nextCursor: null });
    expect(await repo.list({ instanceId, from: at(3), to: at(4) })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await repo.list({ instanceId, from: at(1), to: at(2) })).items).toHaveLength(1);
    expect((await repo.list({ instanceId, limit: 0 })).items).toHaveLength(1);
  });
});

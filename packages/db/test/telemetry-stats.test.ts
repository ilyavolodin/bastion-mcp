import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '../src/config-version';
import { Prisma } from '../src/generated/client';
import { createCallLogRepository, type StatsQuery } from '../src/repositories/telemetry';

const FROM = new Date('2026-03-10T10:00:00Z');
const TO = new Date('2026-03-10T11:00:00Z');
const NOW = new Date('2026-03-10T11:30:00Z');

/** A db whose `$queryRaw` records the flattened SQL and values, and answers with `rows`. */
const fakeDb = (rows: Record<string, unknown>[]) => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      calls.push({ sql: q.text, values: q.values });
      return Promise.resolve(rows);
    },
  } as never;
  return { calls, repo: createCallLogRepository(db) };
};

const lat = (first: number): number[] => [first, ...Array.from({ length: 23 }, () => 0)];
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

const base: StatsQuery = { from: FROM, to: TO, now: NOW };

describe('15.5 stats row mapping', () => {
  it('rejects an empty range', async () => {
    const { repo } = fakeDb([]);
    await expect(repo.stats({ ...base, to: FROM })).rejects.toThrow('empty time range');
  });

  it('maps an ungrouped row to counts and percentiles only', async () => {
    const { repo, calls } = fakeDb([{ cnt: 3, err: 1, bytes: 10n, lat: lat(3) }]);
    const out = await repo.stats(base);
    expect(out.tier).toBe('minute');
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row).toMatchObject({ count: 3, errorCount: 1, bytesOut: 10 });
    expect(row).not.toHaveProperty('bucket');
    expect(row).not.toHaveProperty('installationId');
    expect(row).not.toHaveProperty('catalogEntryId');
    expect(row).not.toHaveProperty('itemName');
    expect(row).not.toHaveProperty('outcome');
    expect(row?.latencyBuckets).toHaveLength(24);
    expect(calls).toHaveLength(1);
    const sql = squash(calls[0]?.sql ?? '');
    expect(sql).toContain('SELECT 1 AS g, sum("count")::int AS cnt');
    expect(sql).toContain('FROM base GROUP BY g ),');
    expect(sql).toContain('GROUP BY g, u.ord');
    expect(sql).toContain('ON h.g = a.g AND h.ord = g2.ord');
    expect(sql).toContain('FROM a ORDER BY g');
  });

  it('maps NIL_UUID to null and keeps real ids, null bytes count as zero', async () => {
    const { repo } = fakeDb([
      {
        installation_id: NIL_UUID,
        catalog_entry_id: NIL_UUID,
        cnt: 1,
        err: 0,
        bytes: null,
        lat: lat(0),
      },
      {
        installation_id: 'i-1',
        catalog_entry_id: null,
        cnt: 2,
        err: 0,
        bytes: 5n,
        lat: lat(0),
      },
    ]);
    const out = await repo.stats({ ...base, groupBy: ['installation', 'catalogEntry'] });
    expect(out.rows[0]).toMatchObject({
      installationId: null,
      catalogEntryId: null,
      bytesOut: 0,
    });
    expect(out.rows[1]).toMatchObject({
      installationId: 'i-1',
      catalogEntryId: null,
      bytesOut: 5,
    });
  });

  it('copies time, item and outcome groups from the raw row', async () => {
    const bucket = new Date('2026-03-10T10:05:00Z');
    const { repo, calls } = fakeDb([
      { bucket, item_name: 'tool', outcome: 'ok', cnt: 1, err: 0, bytes: 1n, lat: lat(1) },
    ]);
    const out = await repo.stats({
      ...base,
      tier: 'hour',
      groupBy: ['time', 'item', 'outcome', 'item'],
    });
    expect(out.tier).toBe('hour');
    expect(out.rows[0]).toMatchObject({ bucket, itemName: 'tool', outcome: 'ok' });
    const sql = squash(calls[0]?.sql ?? '');
    expect(sql).toContain('FROM call_stats_hour WHERE');
    expect(sql).toContain('SELECT bucket, item_name, outcome, sum("count")::int AS cnt');
    expect(sql).toContain('FROM base GROUP BY bucket, item_name, outcome )');
    expect(sql).toContain('GROUP BY bucket, item_name, outcome, u.ord');
    expect(sql).toContain(
      'h.bucket IS NOT DISTINCT FROM a.bucket AND h.item_name IS NOT DISTINCT FROM a.item_name AND h.outcome IS NOT DISTINCT FROM a.outcome',
    );
    expect(sql).toContain('SELECT a.bucket, a.item_name, a.outcome, a.cnt');
    expect(sql).toContain('ORDER BY bucket, item_name, outcome');
  });

  it('adds the optional filters in a fixed order', async () => {
    const { repo, calls } = fakeDb([]);
    await repo.stats({
      ...base,
      installationId: 'inst',
      catalogEntryId: 'cat',
      itemName: 'it',
      outcome: 'ok',
    });
    const sql = squash(calls[0]?.sql ?? '');
    expect(sql).toContain(
      'bucket >= $1 AND bucket < $2 AND installation_id = $3::uuid AND catalog_entry_id = $4::uuid AND item_name = $5 AND outcome = $6',
    );
    expect(calls[0]?.values.slice(2, 6)).toEqual(['inst', 'cat', 'it', 'ok']);
  });
});

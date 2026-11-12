import { describe, expect, it } from 'vitest';
import { listPartitions, PARTITIONED_TABLES } from '../../src/partitions';
import { createCallLogRepository } from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const DAY = 86_400_000;

describe.skipIf(!dbEnabled())(
  '15.5 retention and partition upkeep cover every partitioned table',
  () => {
    const h = useTestDb();

    it('15.5 ensurePartitionsAhead creates partitions on every partitioned table', async () => {
      const repo = createCallLogRepository(h.db.prisma);
      const before: Record<string, number> = {};
      for (const table of PARTITIONED_TABLES) {
        before[table] = (await listPartitions(h.db.prisma, table)).length;
      }
      await repo.ensurePartitionsAhead(12);
      for (const table of PARTITIONED_TABLES) {
        expect((await listPartitions(h.db.prisma, table)).length, table).toBeGreaterThan(
          before[table] ?? Number.MAX_SAFE_INTEGER,
        );
      }
    });

    it('15.5 applyRetention reports and drops partitions of every partitioned table, in table order', async () => {
      const repo = createCallLogRepository(h.db.prisma);
      await repo.ensurePartitionsAhead(9);
      const before: Record<string, number> = {};
      for (const table of PARTITIONED_TABLES) {
        before[table] = (await listPartitions(h.db.prisma, table)).length;
      }
      const result = await repo.applyRetention(new Date(Date.now() + 5 * DAY), {
        logsRetentionDays: 2,
      });
      expect(Object.keys(result.partitions)).toEqual([...PARTITIONED_TABLES]);
      for (const table of PARTITIONED_TABLES) {
        expect(result.partitions[table], table).toBeGreaterThan(0);
        expect((await listPartitions(h.db.prisma, table)).length, table).toBe(
          (before[table] ?? 0) - result.partitions[table],
        );
      }
    });
  },
);

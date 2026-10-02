import type { DbExecutor } from './client';

/** Tables partitioned by day on `ts` (15.5, 8.8, 25.9). */
export const PARTITIONED_TABLES = ['call_log', 'egress_events', 'distribution_events'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

const assertPartitioned = (table: string): PartitionedTable => {
  if (!(PARTITIONED_TABLES as readonly string[]).includes(table)) {
    throw new Error(`${table} is not a partitioned table`);
  }
  return table as PartitionedTable;
};

/** Creates daily partitions from today through `daysAhead` days out; idempotent. */
export const ensurePartitions = async (
  db: DbExecutor,
  table: PartitionedTable,
  daysAhead: number,
): Promise<void> => {
  await db.$executeRaw`SELECT bastion_ensure_partitions(${assertPartitioned(table)}::regclass, ${daysAhead}::int)`;
};

/** Drops daily partitions entirely before `cutoff` and returns how many were dropped. */
export const dropPartitionsBefore = async (
  db: DbExecutor,
  table: PartitionedTable,
  cutoff: Date,
): Promise<number> => {
  const rows = await db.$queryRaw<{ dropped: number }[]>`
    SELECT bastion_drop_partitions_before(${assertPartitioned(table)}::regclass, ${cutoff}::date) AS dropped`;
  return rows[0]?.dropped ?? 0;
};

export const listPartitions = async (
  db: DbExecutor,
  table: PartitionedTable,
): Promise<string[]> => {
  const rows = await db.$queryRaw<{ relname: string }[]>`
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = ${assertPartitioned(table)}::regclass ORDER BY c.relname`;
  return rows.map((row) => row.relname);
};

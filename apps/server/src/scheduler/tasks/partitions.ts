import { MS, PARTITION_DAYS_AHEAD } from '@bastion-mcp/core';
import { dropPartitionsBefore } from '@bastion-mcp/db';
import type { TaskFn } from '../types';

/** `distribution_events` keep 90 days (25.9). */
export const DISTRIBUTION_EVENT_RETENTION_DAYS = 90;
export const PARTITIONS_AHEAD = PARTITION_DAYS_AHEAD;

/** 15.5: partitions of the three telemetry tables exist seven days ahead; idempotent. */
export const ensureTelemetryPartitions: TaskFn = async ({ infra }) => {
  await infra.repos.callLog.ensurePartitionsAhead(PARTITIONS_AHEAD);
  return { daysAhead: PARTITIONS_AHEAD };
};

/**
 * 15.5 retention: whole partitions past `logs.retentionDays` (call_log, egress_events), 90 days for
 * distribution_events, rollup rows past 7 days (minute), 90 days (hour) and 2 years (day), and the oldest prefix of
 * the audit chain past `audit.retentionDays`.
 */
export const applyRetention: TaskFn = async ({ infra, now }) => {
  const at = now();
  const prisma = infra.db.prisma;
  const logsDays = (await infra.repos.orgSettings.get('logs')).retentionDays;
  const auditDays = (await infra.repos.orgSettings.get('audit')).retentionDays;
  const logsCutoff = new Date(at.getTime() - logsDays * MS.DAY);
  const dropped = {
    call_log: await dropPartitionsBefore(prisma, 'call_log', logsCutoff),
    egress_events: await dropPartitionsBefore(prisma, 'egress_events', logsCutoff),
    distribution_events: await dropPartitionsBefore(
      prisma,
      'distribution_events',
      new Date(at.getTime() - DISTRIBUTION_EVENT_RETENTION_DAYS * MS.DAY),
    ),
  };
  // Stats rows only: a huge partition horizon makes `applyRetention` skip partition drops (handled above).
  const stats = await infra.repos.callLog.applyRetention(at, { logsRetentionDays: 36_500 });
  const audit = await infra.repos.auditLog.pruneBefore(new Date(at.getTime() - auditDays * MS.DAY));
  return { dropped, statsRows: stats.statsRows, auditPruned: audit };
};

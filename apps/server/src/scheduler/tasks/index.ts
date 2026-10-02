import type { TaskFn } from '../types';
import { autoInstallPolicy, autoInstallReconcile, autoInstallUser } from './auto-install';
import { kekRewrap, keyRotation } from './keys';
import { cleanupExpired, pinReverification, upstreamTokenSweep } from './maintenance';
import { mirrorPush } from './mirror-push';
import { applyRetention, ensureTelemetryPartitions } from './partitions';
import { registryFullResync, registrySyncDue, registrySyncOne } from './registry-sync';
import { rollups } from './rollups';
import { sandboxGarbageCollection } from './sandbox-gc';

/** Task identifiers (graphile-worker job names). */
export const TASKS = {
  rollups: rollups,
  'partitions:ensure': ensureTelemetryPartitions,
  'retention:apply': applyRetention,
  'registry:sync-due': registrySyncDue,
  'registry:full-resync': registryFullResync,
  'registry:sync-one': registrySyncOne,
  'upstream-tokens:sweep': upstreamTokenSweep,
  'pins:reverify': pinReverification,
  'sandbox:gc': sandboxGarbageCollection,
  'mirror:push': mirrorPush,
  'auto-install:policy': autoInstallPolicy,
  'auto-install:user': autoInstallUser,
  'auto-install:reconcile': autoInstallReconcile,
  'keys:rotate': keyRotation,
  'secrets:rewrap': kekRewrap,
  'oidc:cleanup': cleanupExpired,
} satisfies Record<string, TaskFn<never>>;

export type TaskName = keyof typeof TASKS;

/** Cron schedule (UTC) of the periodic tasks, `crontab` syntax of graphile-worker. */
export const CRON: readonly { schedule: string; task: TaskName }[] = [
  { schedule: '* * * * *', task: 'rollups' },
  { schedule: '* * * * *', task: 'registry:sync-due' },
  { schedule: '*/5 * * * *', task: 'sandbox:gc' },
  { schedule: '*/5 * * * *', task: 'mirror:push' },
  { schedule: '17 * * * *', task: 'oidc:cleanup' },
  { schedule: '5 2 * * *', task: 'partitions:ensure' },
  { schedule: '25 2 * * *', task: 'retention:apply' },
  { schedule: '35 2 * * *', task: 'keys:rotate' },
  { schedule: '45 2 * * *', task: 'secrets:rewrap' },
  { schedule: '55 2 * * *', task: 'auto-install:reconcile' },
  { schedule: '10 3 * * *', task: 'upstream-tokens:sweep' },
  { schedule: '30 3 * * *', task: 'pins:reverify' },
  { schedule: '0 4 * * 0', task: 'registry:full-resync' },
];

export const isTaskName = (name: string): name is TaskName => name in TASKS;

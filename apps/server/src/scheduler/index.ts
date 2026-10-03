import { Logger, makeWorkerUtils, type Runner, run, type WorkerUtils } from 'graphile-worker';
import type { Infra } from '../infra';
import { SCHEDULER_KEEPALIVE_MS, SCHEDULER_LEADER_RETRY_MS, SCHEDULER_POLL_MS } from '../timing';
import { LeaderElection } from './leader';
import { CRON, isTaskName, TASKS, type TaskName } from './tasks';
import type { EnqueueOptions, SchedulerDeps, TaskContext } from './types';

export { CRON, TASKS, type TaskName } from './tasks';
export { rotateKeys } from './tasks/keys';
export type { SchedulerDeps } from './types';

export type Scheduler = {
  /** Starts the leader election loop; the leader runs cron and queued jobs. Idempotent. */
  start(): void;
  /** Stops cron, releases the advisory lock and closes the job connections. */
  stop(): Promise<void>;
  isLeader(): boolean;
  /** Resolves after the first election attempt. */
  ready(): Promise<void>;
  /** Runs one task in this process, outside graphile-worker (CLI, tests, admin "run now"). */
  runNow(task: TaskName, payload?: unknown): Promise<unknown>;
  /** Queues a job for the leader; works from any role and any replica (11.5, 25.5). */
  enqueue(task: TaskName, payload?: unknown, options?: EnqueueOptions): Promise<void>;
  /** Backend pid of the lock connection (tests). */
  lockPid(): number | undefined;
};

const noopGraphileLogger = new Logger(() => () => undefined);

/**
 * The ui role's scheduler (21.1). Exactly one replica holds the advisory lock and runs a graphile-worker runner with
 * the cron items of `CRON`; losing the lock stops the runner within the keepalive interval. Every task is
 * idempotent (see `tasks/`), so an overlap during a handover is harmless.
 */
export const createScheduler = (infra: Infra, deps: SchedulerDeps = {}): Scheduler => {
  const now = deps.now ?? (() => new Date(infra.clock.now()));
  const connectionString = infra.config.databaseUrl;
  let runner: Runner | undefined;
  let utils: Promise<WorkerUtils> | undefined;

  const getUtils = (): Promise<WorkerUtils> => {
    utils ??= (async () => {
      const u = await makeWorkerUtils({ connectionString, logger: noopGraphileLogger });
      await u.migrate();
      return u;
    })();
    return utils;
  };

  const enqueue: TaskContext['enqueue'] = async (task, payload, options = {}) => {
    const u = await getUtils();
    await u.addJob(task, payload ?? {}, {
      ...(options.jobKey ? { jobKey: options.jobKey } : {}),
      ...(options.runAt ? { runAt: options.runAt } : {}),
      maxAttempts: options.maxAttempts ?? 5,
    });
  };

  const ctx: TaskContext = { infra, deps, now, enqueue };

  const taskList = Object.fromEntries(
    Object.entries(TASKS).map(([name, fn]) => [
      name,
      async (payload: unknown): Promise<void> => {
        const started = infra.clock.now();
        await (fn as (c: TaskContext, p: unknown) => Promise<unknown>)(ctx, payload);
        infra.logger.debug({ task: name, ms: infra.clock.now() - started }, 'scheduler task done');
      },
    ]),
  );

  const crontab =
    deps.cron === false ? '' : CRON.map((c) => `${c.schedule} ${c.task} ?max=1`).join('\n');

  const election = new LeaderElection({
    connectionString,
    retryMs: deps.timing?.leaderRetryMs ?? SCHEDULER_LEADER_RETRY_MS,
    keepaliveMs: deps.timing?.keepaliveMs ?? SCHEDULER_KEEPALIVE_MS,
    log: (message, fields) => infra.logger.info(fields ?? {}, message),
    async onGained() {
      await getUtils();
      runner = await run({
        connectionString,
        concurrency: 2,
        noHandleSignals: true,
        pollInterval: deps.timing?.pollIntervalMs ?? SCHEDULER_POLL_MS,
        logger: noopGraphileLogger,
        taskList,
        ...(crontab ? { crontab } : {}),
      });
      runner.promise.catch((error: unknown) =>
        infra.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'job runner stopped',
        ),
      );
    },
    async onLost() {
      const r = runner;
      runner = undefined;
      // Kill, not a graceful stop: the lock is gone, so running must stop now (jobs are idempotent and retried).
      try {
        await r?.kill('scheduler leadership lost');
      } catch {
        // already stopped
      }
    },
  });

  return {
    start: () => election.start(),
    async stop() {
      await election.stop();
      const u = utils;
      utils = undefined;
      if (u) {
        try {
          await (await u).release();
        } catch {
          // pool already closed
        }
      }
    },
    isLeader: () => election.isLeader(),
    ready: () => election.ready(),
    lockPid: () => election.lockPid(),
    async runNow(task, payload) {
      if (!isTaskName(task)) throw new Error(`unknown task ${task}`);
      return (TASKS[task] as (c: TaskContext, p: unknown) => Promise<unknown>)(ctx, payload);
    },
    enqueue: (task, payload, options) => enqueue(task, payload, options),
  };
};

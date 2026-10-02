import type { SandboxDriver } from '@bastion-mcp/sandbox';
import type { Infra } from '../infra';

/**
 * What the scheduler needs from the rest of the server. Every callback is optional: a task whose callback is
 * missing does nothing and succeeds, so the scheduler runs in any role combination (21.1).
 */
export type SchedulerDeps = {
  /** Test seam for time-dependent tasks. */
  now?: () => Date;
  /** Outbound fetch of registry sync (11.6). */
  fetch?: typeof fetch;
  /** Refreshes one upstream OAuth token (9.6); wired to `AuthServices.broker` by the composition root. */
  refreshUpstreamToken?: (principalId: string, installationId: string) => Promise<void>;
  /** Re-verifies the tool-definition pins of one installation against its live definitions (13.6). */
  reverifyPins?: (installationId: string) => Promise<void>;
  /** The sandbox driver for claim GC (8.4); absent in roles without a driver. */
  driver?: SandboxDriver | undefined;
  /** Pushes the latest release of a marketplace to its mirror (25.5); `MirrorPusher.push`. */
  pushMirror?: (marketplaceId: string) => Promise<unknown>;
  /** Called after keys rotated, so this process reloads its keyrings immediately. */
  onKeysRotated?: () => Promise<void>;
  timing?: {
    /** Non-leaders retry the lock this often (default 5 s). */
    leaderRetryMs?: number;
    /** The leader checks its lock connection this often (default 2 s). */
    keepaliveMs?: number;
    /** graphile-worker poll interval (default 1 s). */
    pollIntervalMs?: number;
  };
  /** Set false to run only the leader election and queued jobs, without cron. */
  cron?: boolean;
};

export type EnqueueOptions = { jobKey?: string; runAt?: Date; maxAttempts?: number };

export type TaskContext = {
  infra: Infra;
  deps: SchedulerDeps;
  now: () => Date;
  /** Adds a graphile-worker job (idempotent with `jobKey`). */
  enqueue: (task: string, payload?: unknown, options?: EnqueueOptions) => Promise<void>;
};

export type TaskFn<P = never> = (ctx: TaskContext, payload: P) => Promise<unknown>;

export const BATCH_SIZE = 500;

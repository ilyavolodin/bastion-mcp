import pg from 'pg';

export const SCHEDULER_LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext('bastion-scheduler')) AS locked, pg_backend_pid() AS pid`;

export type LeaderElectionOptions = {
  connectionString: string;
  retryMs: number;
  keepaliveMs: number;
  onGained: () => Promise<void> | void;
  onLost: () => Promise<void> | void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Scheduler leader election (21.1): `pg_try_advisory_lock(hashtext('bastion-scheduler'))` on a DEDICATED connection
 * (a session lock lives and dies with its connection, so it never goes through a pool). The leader checks the
 * connection every `keepaliveMs`; a dropped or failing connection means the lock is gone and leadership is
 * given up at once. Others retry every `retryMs`.
 */
export class LeaderElection {
  private client: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private leader = false;
  private stopped = true;
  private busy = false;
  private pid: number | undefined;
  private firstAttempt: Promise<void> | undefined;
  private resolveFirst: (() => void) | undefined;

  constructor(private readonly options: LeaderElectionOptions) {}

  isLeader(): boolean {
    return this.leader;
  }

  /** Backend pid of the lock connection while leading (tests terminate it to simulate a lost connection). */
  lockPid(): number | undefined {
    return this.leader ? this.pid : undefined;
  }

  /** Resolves after the first election attempt, win or lose. */
  ready(): Promise<void> {
    return this.firstAttempt ?? Promise.resolve();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.firstAttempt = new Promise((resolve) => {
      this.resolveFirst = resolve;
    });
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.giveUp(true);
    this.resolveFirst?.();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (this.leader) {
        await this.keepalive();
        this.schedule(this.options.keepaliveMs);
      } else {
        await this.attempt();
        this.schedule(this.leader ? this.options.keepaliveMs : this.options.retryMs);
      }
    } finally {
      this.busy = false;
      this.resolveFirst?.();
      this.resolveFirst = undefined;
    }
  }

  private async attempt(): Promise<void> {
    const client = new pg.Client({ connectionString: this.options.connectionString });
    client.on('error', () => void this.giveUp(false));
    client.on('end', () => void this.giveUp(false));
    try {
      await client.connect();
      const res = await client.query<{ locked: boolean; pid: number }>(SCHEDULER_LOCK_SQL);
      if (!res.rows[0]?.locked) {
        client.removeAllListeners();
        client.on('error', () => undefined);
        await client.end().catch(() => undefined);
        return;
      }
      if (this.stopped) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.pid = res.rows[0].pid;
      this.leader = true;
      this.options.log?.('scheduler leadership gained');
      await this.options.onGained();
    } catch (error) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
      this.options.log?.('scheduler election failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async keepalive(): Promise<void> {
    const client = this.client;
    if (!client) return this.giveUp(false);
    try {
      await Promise.race([
        client.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('keepalive timeout')),
            Math.max(this.options.keepaliveMs, 1000),
          ).unref(),
        ),
      ]);
    } catch {
      await this.giveUp(false);
    }
  }

  private async giveUp(release: boolean): Promise<void> {
    const client = this.client;
    const wasLeader = this.leader;
    this.client = undefined;
    this.leader = false;
    this.pid = undefined;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      if (release) await client.query(`SELECT pg_advisory_unlock_all()`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    if (wasLeader) {
      this.options.log?.('scheduler leadership lost');
      await this.options.onLost();
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.schedule(this.options.retryMs);
      }
    }
  }
}

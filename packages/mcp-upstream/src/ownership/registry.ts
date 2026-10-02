import { redisKeys, TTL } from '@bastion-mcp/core';
import { z } from 'zod';
import { type Clock, type Logger, noopLogger, type RedisLike, systemClock } from '../ports';

/**
 * Worker registry (21.2): `workers:{workerId}` = `{ address, role, version, startedAt }` every 5 s with a 15 s TTL, so
 * other replicas know where to forward and which lease holders are still alive.
 */

export const HEARTBEAT_INTERVAL_MS = TTL.leaseRenewInterval * 1000;
export const REGISTRY_TTL_MS = TTL.workerRegistry * 1000;

export type WorkerInfo = {
  address: string;
  role: string;
  version: string;
  startedAt: number;
  /** Set during graceful shutdown: still serves what it owns, takes no new ownership (21.2). */
  draining: boolean;
};

const workerSchema = z.object({
  address: z.string().min(1),
  role: z.string(),
  version: z.string(),
  startedAt: z.coerce.number(),
  draining: z.string().optional(),
});

export type WorkerRegistryOptions = {
  redis: RedisLike;
  workerId: string;
  /** `<podIP>:7443` */
  address: string;
  role: string;
  version: string;
  clock?: Clock;
  logger?: Logger;
};

export class WorkerRegistry {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private readonly startedAt: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly options: WorkerRegistryOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.startedAt = this.clock.now();
  }

  get workerId(): string {
    return this.options.workerId;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Writes the registry entry and refreshes its TTL. Failures are logged, never thrown (Redis outage, 21.3). */
  async heartbeat(): Promise<void> {
    const key = redisKeys.worker(this.options.workerId);
    try {
      await this.options.redis.hset(key, {
        address: this.options.address,
        role: this.options.role,
        version: this.options.version,
        startedAt: String(this.startedAt),
        ...(this.draining ? { draining: '1' } : {}),
      });
      await this.options.redis.pexpire(key, REGISTRY_TTL_MS);
    } catch (error) {
      this.logger.warn('worker heartbeat failed', { error: String(error) });
    }
  }

  async start(): Promise<void> {
    await this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Marks the worker draining in `workers:{id}` (21.2 graceful shutdown). */
  async markDraining(): Promise<void> {
    this.draining = true;
    await this.heartbeat();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.options.redis.del(redisKeys.worker(this.options.workerId)).catch(() => 0);
  }

  /** A worker that is still registered, or null when it is gone (its lease is up for takeover). */
  async lookup(workerId: string): Promise<WorkerInfo | null> {
    const raw = await this.options.redis.hgetall(redisKeys.worker(workerId));
    if (Object.keys(raw).length === 0) return null;
    const parsed = workerSchema.safeParse(raw);
    if (!parsed.success) return null;
    return { ...parsed.data, draining: parsed.data.draining === '1' };
  }
}

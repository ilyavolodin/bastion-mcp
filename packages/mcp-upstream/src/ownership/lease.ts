import { redisKeys, TTL } from '@bastion-mcp/core';
import { type Clock, type Logger, noopLogger, type RedisLike, systemClock } from '../ports';
import { COMPARE_AND_DELETE, COMPARE_AND_PEXPIRE } from './lua';
import type { WorkerRegistry } from './registry';

/**
 * Owner leases (21.2): `lease:{instanceId}` holds the owning workerId for 15 s, renewed every 5 s with a
 * compare-and-PEXPIRE script. A lease that cannot be renewed is treated as lost.
 */

export const LEASE_TTL_MS = TTL.lease * 1000;
export const LEASE_RENEW_INTERVAL_MS = TTL.leaseRenewInterval * 1000;

export type AcquireResult =
  | { kind: 'local'; fresh: boolean }
  | { kind: 'forward'; workerId: string; address: string };

type Owned = { onLost: () => void; lastRenewedAt: number };

export type LeaseManagerOptions = {
  redis: RedisLike;
  registry: WorkerRegistry;
  clock?: Clock;
  logger?: Logger;
  ttlMs?: number;
  renewIntervalMs?: number;
};

export class LeaseManager {
  private readonly owned = new Map<string, Owned>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;

  constructor(private readonly options: LeaseManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
  }

  get workerId(): string {
    return this.options.registry.workerId;
  }

  isOwner(instanceId: string): boolean {
    return this.owned.has(instanceId);
  }

  ownedIds(): string[] {
    return [...this.owned.keys()];
  }

  /**
   * The algorithm of 21.2: read the lease; ours means use the local connection; another registered owner means
   * forward; empty or dead means compare-and-delete the stale value, `SET NX PX 15000`, then `attach`.
   * A failing `attach` gives the lease back before the error propagates.
   */
  async acquire(
    instanceId: string,
    options: { attach: () => Promise<void>; onLost: () => void },
  ): Promise<AcquireResult> {
    const { redis, registry } = this.options;
    const key = redisKeys.lease(instanceId);
    const me = this.workerId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const holder = await redis.get(key);
      if (holder === me) {
        if (this.owned.has(instanceId)) return { kind: 'local', fresh: false };
        // Our own stale lease from before a restart that kept the worker id: take it over.
        this.track(instanceId, options.onLost);
        await this.attach(instanceId, options.attach);
        return { kind: 'local', fresh: true };
      }
      if (holder !== null) {
        const worker = await registry.lookup(holder);
        if (worker) return { kind: 'forward', workerId: holder, address: worker.address };
        await redis.eval(COMPARE_AND_DELETE, 1, key, holder);
      }
      if (registry.isDraining) {
        throw new Error('this worker is draining and takes no new instance ownership');
      }
      const ok = await redis.set(key, me, 'PX', this.ttlMs, 'NX');
      if (ok === null) continue; // lost the race: re-read
      this.track(instanceId, options.onLost);
      await this.attach(instanceId, options.attach);
      return { kind: 'local', fresh: true };
    }
    throw new Error(`could not acquire or locate the owner of instance ${instanceId}`);
  }

  private async attach(instanceId: string, attach: () => Promise<void>): Promise<void> {
    try {
      await attach();
    } catch (error) {
      await this.release(instanceId);
      throw error;
    }
  }

  private track(instanceId: string, onLost: () => void): void {
    this.owned.set(instanceId, { onLost, lastRenewedAt: this.clock.now() });
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.renewAll(), this.renewIntervalMs);
    this.timer.unref?.();
  }

  /** One renewal pass (also called by tests). */
  async renewAll(): Promise<void> {
    const me = this.workerId;
    for (const [instanceId, owned] of [...this.owned]) {
      let lost = false;
      try {
        const renewed = await this.options.redis.eval(
          COMPARE_AND_PEXPIRE,
          1,
          redisKeys.lease(instanceId),
          me,
          this.ttlMs,
        );
        if (renewed === 1 || renewed === '1') owned.lastRenewedAt = this.clock.now();
        else lost = true;
      } catch (error) {
        this.logger.warn('lease renewal failed', { instanceId, error: String(error) });
        // The lease expires on its own after its TTL: past that point somebody else may own it.
        if (this.clock.now() - owned.lastRenewedAt >= this.ttlMs) lost = true;
      }
      if (lost) {
        this.owned.delete(instanceId);
        this.logger.warn('lease lost, closing the instance connection', { instanceId });
        try {
          owned.onLost();
        } catch (error) {
          this.logger.error('onLost handler threw', { instanceId, error: String(error) });
        }
      }
    }
    if (this.owned.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async release(instanceId: string): Promise<void> {
    this.owned.delete(instanceId);
    await this.options.redis
      .eval(COMPARE_AND_DELETE, 1, redisKeys.lease(instanceId), this.workerId)
      .catch(() => 0);
  }

  /** Graceful shutdown: delete every lease this worker holds (21.2). Sandboxes keep running. */
  async releaseAll(): Promise<void> {
    const ids = [...this.owned.keys()];
    for (const id of ids) await this.release(id);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the current owner without taking it (used to route subscriptions and resumes). */
  async locate(instanceId: string): Promise<AcquireResult | { kind: 'vacant' }> {
    const holder = await this.options.redis.get(redisKeys.lease(instanceId));
    if (holder === null) return { kind: 'vacant' };
    if (holder === this.workerId) return { kind: 'local', fresh: false };
    const worker = await this.options.registry.lookup(holder);
    return worker
      ? { kind: 'forward', workerId: holder, address: worker.address }
      : { kind: 'vacant' };
  }
}

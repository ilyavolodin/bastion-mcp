import { TIMEOUTS_MS } from '@bastion-mcp/core';
import { type Logger, noopLogger } from '../ports';
import type { LeaseManager } from './lease';
import type { WorkerRegistry } from './registry';

/**
 * Graceful shutdown (21.2, SIGTERM): mark the worker draining, stop accepting ownership, finish in-flight
 * operations (up to 25 s), then delete the leases. Sandboxes keep running and are re-attached by whichever worker
 * gets the next request.
 */
export class InflightTracker {
  private count = 0;
  private waiters: (() => void)[] = [];

  get active(): number {
    return this.count;
  }

  /** Runs `fn` as one in-flight operation. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.count += 1;
    try {
      return await fn();
    } finally {
      this.count -= 1;
      if (this.count === 0) for (const w of this.waiters.splice(0)) w();
    }
  }

  /** Resolves when nothing is in flight, or after `timeoutMs`; returns whether it drained. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.count === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export type ShutdownOptions = {
  registry: WorkerRegistry;
  leases: LeaseManager;
  inflight: InflightTracker;
  /** Closes connections without stopping sandboxes. */
  closeConnections: () => Promise<void>;
  graceMs?: number;
  logger?: Logger;
};

export const gracefulShutdown = async (options: ShutdownOptions): Promise<{ drained: boolean }> => {
  const logger = options.logger ?? noopLogger;
  await options.registry.markDraining();
  const drained = await options.inflight.drain(options.graceMs ?? TIMEOUTS_MS.graceful);
  if (!drained) logger.warn('graceful shutdown: in-flight operations did not finish in time');
  await options.closeConnections();
  await options.leases.releaseAll();
  await options.registry.stop();
  return { drained };
};

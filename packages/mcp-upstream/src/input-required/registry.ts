import { redisKeys, TTL } from '@bastion-mcp/core';
import { z } from 'zod';
import { type Clock, type Logger, noopLogger, type RedisLike, systemClock } from '../ports';
import type { LegacyCallScope } from './call-scope';

/**
 * Owner-side registry of legacy-upstream continuations (6.5): the scope (with the SDK handler promises) lives in a
 * local map, `cont:{continuationId}` in Redis lets any replica find the owner, TTL 10 minutes.
 */

const recordSchema = z.object({
  instanceId: z.string(),
  workerId: z.string(),
  pendingKeys: z.string().transform((text, ctx) => {
    try {
      return z.array(z.string()).parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid pendingKeys' });
      return z.NEVER;
    }
  }),
  createdAt: z.coerce.number(),
});
export type ContinuationRecord = z.infer<typeof recordSchema>;

export class ContinuationRegistry {
  private readonly scopes = new Map<string, LegacyCallScope>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      redis: RedisLike;
      workerId: string;
      instanceId: string;
      ttlMs?: number;
      clock?: Clock;
      logger?: Logger;
    },
  ) {
    this.ttlMs = options.ttlMs ?? TTL.continuation * 1000;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
  }

  get size(): number {
    return this.scopes.size;
  }

  get(continuationId: string): LegacyCallScope | undefined {
    return this.scopes.get(continuationId);
  }

  /** Records the continuation and (re)arms its TTL. Called each time a batch is handed out. */
  async publish(scope: LegacyCallScope): Promise<void> {
    const key = redisKeys.continuation(scope.id);
    const first = !this.scopes.has(scope.id);
    this.scopes.set(scope.id, scope);
    if (first) scope.onSettled(() => void this.finish(scope.id));
    await this.options.redis.hset(key, {
      instanceId: this.options.instanceId,
      workerId: this.options.workerId,
      pendingKeys: JSON.stringify(scope.pendingKeys),
      createdAt: String(this.clock.now()),
    });
    await this.options.redis.pexpire(key, this.ttlMs);
    this.armTtl(scope);
  }

  private armTtl(scope: LegacyCallScope): void {
    const previous = this.timers.get(scope.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.logger.warn('continuation expired without a retry', { continuationId: scope.id });
      scope.expire();
      void this.finish(scope.id);
    }, this.ttlMs);
    timer.unref?.();
    this.timers.set(scope.id, timer);
  }

  /** Stops the TTL while a retry is being served. */
  hold(continuationId: string): void {
    const timer = this.timers.get(continuationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(continuationId);
  }

  async finish(continuationId: string): Promise<void> {
    this.hold(continuationId);
    this.scopes.delete(continuationId);
    await this.options.redis.del(redisKeys.continuation(continuationId)).catch(() => 0);
  }

  /** The connection closed: every continuation of this instance is gone. */
  async closeAll(): Promise<void> {
    for (const scope of [...this.scopes.values()]) {
      scope.dispose();
      await this.finish(scope.id);
    }
  }
}

/** Reads `cont:{id}` from any replica; null when absent or malformed (the owner died or the TTL passed). */
export const lookupContinuation = async (
  redis: RedisLike,
  continuationId: string,
): Promise<ContinuationRecord | null> => {
  const raw = await redis.hgetall(redisKeys.continuation(continuationId));
  if (Object.keys(raw).length === 0) return null;
  const parsed = recordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

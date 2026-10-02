import { redisKeys } from '@bastion-mcp/core';
import { DECR_FLOOR } from '../ownership/lua';
import type { RedisLike } from '../ports';

/** In-flight call counter per instance in Redis `inflight:{instanceId}` (8.6): least-loaded replica selection, LRU eligibility. */
const SAFETY_TTL_MS = 10 * 60 * 1000;

export class InflightCounter {
  constructor(private readonly redis: RedisLike) {}

  async incr(instanceId: string): Promise<number> {
    const key = redisKeys.inflight(instanceId);
    const value = await this.redis.incr(key);
    // A crashed worker never decrements: the counter expires on its own.
    await this.redis.pexpire(key, SAFETY_TTL_MS);
    return value;
  }

  async decr(instanceId: string): Promise<number> {
    const value = await this.redis.eval(DECR_FLOOR, 1, redisKeys.inflight(instanceId));
    return Number(value);
  }

  async get(instanceId: string): Promise<number> {
    const raw = await this.redis.get(redisKeys.inflight(instanceId));
    return raw === null ? 0 : Math.max(0, Number(raw));
  }
}

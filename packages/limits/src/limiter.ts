import { EngineLimiter, type TimeZoneSource } from './engine';
import { RedisBackend } from './redis-backend';
import { ResilientLimiter, type ResilientOptions } from './resilient';
import type { Clock, RedisLike } from './types';

export type RedisLimiterOptions = { redis: RedisLike; clock?: Clock; timeZone?: TimeZoneSource };

const engineOptions = (o: { clock?: Clock; timeZone?: TimeZoneSource }) => ({
  ...(o.clock ? { clock: o.clock } : {}),
  ...(o.timeZone === undefined ? {} : { timeZone: o.timeZone }),
});

/** Redis-only limiter; throws `LimiterBackendError` when Redis fails. */
export const createRedisLimiter = (options: RedisLimiterOptions): EngineLimiter =>
  new EngineLimiter(new RedisBackend(options.redis), engineOptions(options));

/** The production limiter: Redis with automatic fail-open fallback (14.2, 21.3). */
export const createLimiter = (
  options: RedisLimiterOptions &
    Pick<ResilientOptions, 'expectedWorkers' | 'onDegraded' | 'redisTimeoutMs' | 'probeIntervalMs'>,
): ResilientLimiter => {
  const { redis, ...rest } = options;
  return new ResilientLimiter(createRedisLimiter({ redis, ...engineOptions(rest) }), rest);
};

import type { RedisLike as AuthRedisLike, OAuthRedisLike, PubSub } from '@bastion-mcp/auth';
import { REDIS_CHANNELS } from '@bastion-mcp/core';
import type { Redis } from 'ioredis';

/** `RedisLike` of the identity layer (TTL seconds, void returns) over ioredis. */
export const authRedis = (redis: Redis): AuthRedisLike & OAuthRedisLike => ({
  get: (key) => redis.get(key),
  async set(key, value, ttlSeconds) {
    if (ttlSeconds === undefined) await redis.set(key, value);
    else await redis.set(key, value, 'EX', ttlSeconds);
  },
  async del(key) {
    await redis.del(key);
  },
  async expire(key, ttlSeconds) {
    return (await redis.expire(key, ttlSeconds)) === 1;
  },
  async hgetall(key) {
    return redis.hgetall(key);
  },
  async hset(key, fields) {
    await redis.hset(key, fields);
  },
  incr: (key) => redis.incr(key),
});

/**
 * Redis pub/sub on one dedicated subscriber connection; handlers are multiplexed per channel. The connection is
 * created lazily on the first `subscribe`.
 */
export class RedisPubSub implements PubSub {
  private sub: Redis | undefined;
  private readonly handlers = new Map<string, Set<(message: string) => void>>();

  constructor(private readonly redis: Redis) {}

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }

  subscribe(channel: string, handler: (message: string) => void): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.connection()
        .subscribe(channel)
        .catch(() => undefined);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  private connection(): Redis {
    if (!this.sub) {
      this.sub = this.redis.duplicate();
      this.sub.on('error', () => undefined);
      this.sub.on('message', (channel: string, message: string) => {
        for (const handler of this.handlers.get(channel) ?? []) {
          try {
            handler(message);
          } catch {
            // a failing handler never affects the others
          }
        }
      });
    }
    return this.sub;
  }

  async close(): Promise<void> {
    if (this.sub) await this.sub.quit().catch(() => undefined);
    this.sub = undefined;
    this.handlers.clear();
  }
}

export const CONFIG_CHANNEL = REDIS_CHANNELS.config;

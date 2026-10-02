import { FLOOD_LIMITS } from '@bastion-mcp/core';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

export type FloodBucket = 'mcp' | 'oauth';
export type FloodResult = { ok: true; retryAfterSec: 0 } | { ok: false; retryAfterSec: number };

/** Maps a request path to its flood bucket: `/mcp*` and `/oauth/token|register` (14.2). */
export const floodBucketFor = (path: string): FloodBucket | undefined => {
  const clean = path.split('?')[0] ?? path;
  if (clean === '/mcp' || clean.startsWith('/mcp/')) return 'mcp';
  if (clean === '/oauth/token' || clean === '/oauth/register') return 'oauth';
  return undefined;
};

/**
 * Pre-auth per-IP flood control (14.2). In-memory on purpose: it runs before authentication and body
 * parsing and must not depend on Redis. The HTTP layer answers `429` with `Retry-After: retryAfterSec`.
 */
export class FloodLimiter {
  private readonly limiters: Record<FloodBucket, RateLimiterMemory>;

  constructor(limits: { mcpPerMinute: number; oauthPerMinute: number } = FLOOD_LIMITS) {
    this.limiters = {
      mcp: new RateLimiterMemory({
        keyPrefix: 'flood:mcp',
        points: limits.mcpPerMinute,
        duration: 60,
      }),
      oauth: new RateLimiterMemory({
        keyPrefix: 'flood:oauth',
        points: limits.oauthPerMinute,
        duration: 60,
      }),
    };
  }

  async check(ip: string, bucket: FloodBucket): Promise<FloodResult> {
    try {
      await this.limiters[bucket].consume(ip, 1);
      return { ok: true, retryAfterSec: 0 };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(error.msBeforeNext / 1000)) };
      }
      throw error;
    }
  }
}

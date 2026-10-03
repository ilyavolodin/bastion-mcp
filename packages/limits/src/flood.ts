import { FLOOD_LIMITS, SECONDS } from '@bastion-mcp/core';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

/** The flood limits are per minute. */
const FLOOD_WINDOW_SECONDS = SECONDS.MINUTE;

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
    const bucket = (name: FloodBucket, points: number) =>
      new RateLimiterMemory({
        keyPrefix: `flood:${name}`,
        points,
        duration: FLOOD_WINDOW_SECONDS,
      });
    this.limiters = {
      mcp: bucket('mcp', limits.mcpPerMinute),
      oauth: bucket('oauth', limits.oauthPerMinute),
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

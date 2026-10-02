import { redisKeys, TTL } from '@bastion-mcp/core';
import type { PriorDiscovery } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { RedisLike } from '../ports';

/**
 * The era verdict of a remote upstream, cached in `era:{installationId}:{credentialHash}` for 24 hours (6.4) so
 * only the first connection per credential probes.
 */

const verdictSchema = z.union([
  z.object({ kind: z.literal('legacy') }),
  z.object({
    kind: z.literal('modern'),
    discover: z.looseObject({ supportedVersions: z.array(z.string()) }),
  }),
]);

export class EraCache {
  constructor(private readonly redis: RedisLike) {}

  async get(installationId: string, credentialHash: string): Promise<PriorDiscovery | undefined> {
    let raw: string | null;
    try {
      raw = await this.redis.get(redisKeys.era(installationId, credentialHash));
    } catch {
      return undefined; // Redis down: probe again (21.3)
    }
    if (raw === null) return undefined;
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as PriorDiscovery) : undefined;
    } catch {
      return undefined;
    }
  }

  async put(
    installationId: string,
    credentialHash: string,
    verdict: PriorDiscovery,
  ): Promise<void> {
    try {
      await this.redis.set(
        redisKeys.era(installationId, credentialHash),
        JSON.stringify(verdict),
        'EX',
        TTL.eraCache,
      );
    } catch {
      // best effort
    }
  }

  async forget(installationId: string, credentialHash: string): Promise<void> {
    await this.redis.del(redisKeys.era(installationId, credentialHash)).catch(() => 0);
  }
}

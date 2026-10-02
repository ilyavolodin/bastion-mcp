import { redisKeys } from '@bastion-mcp/core';
import type { EgressPolicy } from '@bastion-mcp/sandbox';
import { z } from 'zod';
import type { EgressPolicyWriter, RedisLike } from '../ports';

/**
 * Redis `egress:{instanceId}` = `{tokenSha256, allow, phase}` (8.8). The owner writes it at start and on every phase
 * change; any worker's egress proxy reads it through the sandbox package's `EgressPolicyStore`.
 */

const policySchema = z.object({
  tokenSha256: z.string(),
  allow: z.string().transform((text, ctx) => {
    try {
      return z.array(z.string()).parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid allow list' });
      return z.NEVER;
    }
  }),
  phase: z.string(),
});

export class RedisEgressPolicyStore implements EgressPolicyWriter {
  constructor(private readonly redis: RedisLike) {}

  async get(instanceId: string): Promise<EgressPolicy | null> {
    const raw = await this.redis.hgetall(redisKeys.egress(instanceId));
    if (Object.keys(raw).length === 0) return null;
    const parsed = policySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async set(instanceId: string, policy: EgressPolicy): Promise<void> {
    await this.redis.hset(redisKeys.egress(instanceId), {
      tokenSha256: policy.tokenSha256,
      allow: JSON.stringify(policy.allow),
      phase: policy.phase,
    });
  }

  async delete(instanceId: string): Promise<void> {
    await this.redis.del(redisKeys.egress(instanceId));
  }
}

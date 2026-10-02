import { ConcurrencyRuleSchema, QuotaRuleSchema, RateRuleSchema } from '@bastion-mcp/limits';
import { z } from 'zod';

export const limitRuleCreateSchema = z.discriminatedUnion('kind', [
  RateRuleSchema.omit({ id: true }).extend({
    ownerTeamId: z.string().min(1).nullable().optional(),
  }),
  QuotaRuleSchema.omit({ id: true }).extend({
    ownerTeamId: z.string().min(1).nullable().optional(),
  }),
  ConcurrencyRuleSchema.omit({ id: true }).extend({
    ownerTeamId: z.string().min(1).nullable().optional(),
  }),
]);

/** A patch may change any field of the rule; the merged rule is validated as a whole. */
export const limitRulePatchSchema = z
  .object({
    name: z.string().min(1),
    subject: z.string(),
    subjectMatch: z.unknown(),
    scope: z.record(z.string(), z.unknown()),
    params: z.record(z.string(), z.unknown()),
    metric: z.string(),
    cost: z.record(z.string(), z.number()).nullable(),
    action: z.string(),
    enabled: z.boolean(),
    ownerTeamId: z.string().min(1).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export const usageQuerySchema = z.object({ subjectId: z.string().min(1).max(256).optional() });

export const usageResultSchema = z.object({
  items: z.array(
    z.object({
      ruleId: z.string(),
      kind: z.string(),
      subjectId: z.string(),
      limit: z.number(),
      consumed: z.number(),
      remaining: z.number(),
      resetsAt: z.string().nullable(),
    }),
  ),
});

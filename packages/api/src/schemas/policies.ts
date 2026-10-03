import { POLICY_EFFECTS } from '@bastion-mcp/core';
import { customPolicyTestSchema, toolRuleRowSchema } from '@bastion-mcp/policy';
import { z } from 'zod';
import { decisionSchema, nameSchema } from './common';

const atLeastOne = (v: object) => Object.keys(v).length > 0;

const ruleFields = {
  name: nameSchema,
  ownerTeamId: z.string().min(1).nullable(),
  effect: z.enum(POLICY_EFFECTS),
  who: toolRuleRowSchema.shape.who,
  what: toolRuleRowSchema.shape.what,
  when: toolRuleRowSchema.shape.when,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100000),
};

export const policyRuleCreateSchema = z.object({
  name: ruleFields.name,
  ownerTeamId: ruleFields.ownerTeamId.default(null),
  effect: ruleFields.effect,
  who: ruleFields.who,
  what: ruleFields.what,
  when: ruleFields.when,
  enabled: ruleFields.enabled.default(true),
  priority: ruleFields.priority.default(100),
});

export const policyRulePatchSchema = z
  .object(ruleFields)
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const customPolicyCreateSchema = z.object({
  name: nameSchema,
  cedar: z
    .string()
    .min(1)
    .max(256 * 1024),
  tests: z.array(customPolicyTestSchema).min(1),
  enabled: z.boolean().default(true),
});

export const customPolicyPatchSchema = z
  .object({
    name: nameSchema,
    cedar: z
      .string()
      .min(1)
      .max(256 * 1024),
    tests: z.array(customPolicyTestSchema).min(1),
    enabled: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'at least one field is required');

export const validationReportSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  tests: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      expected: decisionSchema,
      actual: z.enum(['allow', 'deny', 'error']),
      reasons: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
});

export const simulationResultSchema = z.object({
  decision: decisionSchema,
  reasons: z.array(z.string()),
  errors: z.array(z.string()),
  determiningPolicies: z.array(z.object({ id: z.string(), text: z.string() })),
});

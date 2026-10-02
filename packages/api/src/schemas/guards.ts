import { orgSettingsSchema } from '@bastion-mcp/core';
import { guardProfileSchema } from '@bastion-mcp/guards';
import { z } from 'zod';

const profileBody = guardProfileSchema.omit({ profileId: true });

export const guardProfileCreateSchema = profileBody.extend({
  name: z.string().trim().min(1).max(200),
  isOrgDefault: z.boolean().default(false),
});

export const guardProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    isOrgDefault: z.boolean(),
    guards: guardProfileSchema.shape.guards,
    latencyBudgetMs: guardProfileSchema.shape.latencyBudgetMs,
    maxScanBytes: guardProfileSchema.shape.maxScanBytes,
    onOversize: guardProfileSchema.shape.onOversize,
    onDrift: guardProfileSchema.shape.onDrift,
    riskEscalation: guardProfileSchema.shape.riskEscalation,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export const guardTestBodySchema = z.object({
  text: z
    .string()
    .min(1)
    .max(256 * 1024),
  phase: z.enum(['tool_input', 'tool_output', 'prompt', 'resource']).default('tool_output'),
});

export const guardTestResultSchema = z.object({
  blocked: z.boolean(),
  durationMs: z.number(),
  findings: z.array(
    z.object({
      guard: z.string(),
      type: z.string(),
      verdict: z.enum(['clean', 'suspicious', 'malicious']),
      action: z.string(),
      detail: z.string().optional(),
    }),
  ),
});

export const modelGuardsSchema = orgSettingsSchema.shape.modelGuards;
export const modelGuardsView = modelGuardsSchema.extend({ updatedAt: z.string().nullable() });

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

/** The stored config of the three model guards, as the guards read it (13.5); every field passes through. */
const modelGuardConfig = z.looseObject({
  endpoint: z.string().optional(),
  url: z.string().optional(),
  model: z.string().optional(),
  apiKeySecret: z.string().optional(),
  auth: z.looseObject({ header: z.string(), secret: z.string() }).optional(),
  maliciousLabels: z.array(z.string()).optional(),
  threshold: z.number().optional(),
  thresholds: z
    .looseObject({
      block: z.number().optional(),
      quarantine: z.number().optional(),
      warn: z.number().optional(),
    })
    .optional(),
  timeoutMs: z.number().optional(),
});

/** Response of `GET`/`PUT /settings/model-guards`: each guard is its config, or `null` when off. */
export const modelGuardsResponse = z
  .object({
    jev: modelGuardConfig.nullable(),
    llmJudge: modelGuardConfig.nullable(),
    classifier: modelGuardConfig.nullable(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'ModelGuards' });

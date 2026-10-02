import { DEFAULT_LIMIT_RULES } from '@bastion-mcp/core';
import { z } from 'zod';

/** Rule model (14.1). Mirrors the `limit_rules` table (16.2). */
export const SUBJECTS = ['user', 'team', 'role', 'serviceAccount', 'org', 'client'] as const;
export const METRICS = ['calls', 'bytesOut', 'samplingRequests', 'modelGuardTokens'] as const;
export const ACTIONS = ['reject', 'warn'] as const;
export const QUOTA_PERIODS = ['day', 'week', 'month'] as const;

export const SubjectSchema = z.enum(SUBJECTS);
export const MetricSchema = z.enum(METRICS);
export const ActionSchema = z.enum(ACTIONS);
export const QuotaPeriodSchema = z.enum(QUOTA_PERIODS);

/** `each` keeps one counter per subject; a list of ids restricts the rule to those subjects (14.1). */
export const SubjectMatchSchema = z.union([z.literal('each'), z.array(z.string().min(1)).min(1)]);

export const ScopeSchema = z.object({
  installationId: z.string().min(1).optional(),
  catalogEntryId: z.string().min(1).optional(),
  /** Glob over the namespaced tool name, for example `bigquery__*`. */
  tool: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
});

export const RateParamsSchema = z.object({
  points: z.number().int().positive(),
  perSeconds: z.number().int().positive(),
  burst: z.number().int().nonnegative(),
});
export const QuotaParamsSchema = z.object({
  points: z.number().int().positive(),
  period: QuotaPeriodSchema,
});
export const ConcurrencyParamsSchema = z.object({
  max: z.number().int().positive(),
  leaseSeconds: z.number().int().positive().default(900),
});

const base = {
  id: z.string().min(1),
  name: z.string().min(1),
  subject: SubjectSchema,
  subjectMatch: SubjectMatchSchema.default('each'),
  scope: ScopeSchema.default({}),
  metric: MetricSchema.default('calls'),
  cost: z.record(z.string(), z.number().int().positive()).optional(),
  action: ActionSchema.default('reject'),
  enabled: z.boolean().default(true),
};

export const RateRuleSchema = z.object({
  ...base,
  kind: z.literal('rate'),
  params: RateParamsSchema,
});
export const QuotaRuleSchema = z.object({
  ...base,
  kind: z.literal('quota'),
  params: QuotaParamsSchema,
});
export const ConcurrencyRuleSchema = z.object({
  ...base,
  kind: z.literal('concurrency'),
  params: ConcurrencyParamsSchema,
});

export const RuleSchema = z.discriminatedUnion('kind', [
  RateRuleSchema,
  QuotaRuleSchema,
  ConcurrencyRuleSchema,
]);

export type Subject = z.infer<typeof SubjectSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type QuotaPeriod = z.infer<typeof QuotaPeriodSchema>;
export type RateRule = z.infer<typeof RateRuleSchema>;
export type QuotaRule = z.infer<typeof QuotaRuleSchema>;
export type ConcurrencyRule = z.infer<typeof ConcurrencyRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type RuleInput = z.input<typeof RuleSchema>;

/** Parses a rule from a trust boundary (a JSONB row or an API body). */
export const parseRule = (input: unknown): Rule => RuleSchema.parse(input);

/** The default rules of 14.3 as data. The running-sandbox cap is enforced by `planSandboxStart` (8.6). */
export const defaultRules = (): Rule[] => [
  {
    id: 'default:user-calls',
    name: 'Per user, all calls',
    subject: 'user',
    subjectMatch: 'each',
    scope: {},
    kind: 'rate',
    params: { ...DEFAULT_LIMIT_RULES.userCalls },
    metric: 'calls',
    action: 'reject',
    enabled: true,
  },
  {
    id: 'default:user-concurrency',
    name: 'Per user, concurrency',
    subject: 'user',
    subjectMatch: 'each',
    scope: {},
    kind: 'concurrency',
    params: { ...DEFAULT_LIMIT_RULES.userConcurrency },
    metric: 'calls',
    action: 'reject',
    enabled: true,
  },
  {
    id: 'default:service-account-calls',
    name: 'Per service account, all calls',
    subject: 'serviceAccount',
    subjectMatch: 'each',
    scope: {},
    kind: 'rate',
    params: { ...DEFAULT_LIMIT_RULES.serviceAccountCalls },
    metric: 'calls',
    action: 'reject',
    enabled: true,
  },
  {
    id: 'default:user-sampling',
    name: 'Per user, sampling requests',
    subject: 'user',
    subjectMatch: 'each',
    scope: {},
    kind: 'quota',
    params: { points: DEFAULT_LIMIT_RULES.userSamplingPerDay, period: 'day' },
    metric: 'samplingRequests',
    action: 'reject',
    enabled: true,
  },
];

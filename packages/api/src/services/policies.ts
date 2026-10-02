import {
  compileRule,
  type PolicyDataInput,
  simulate,
  toolRuleRowSchema,
  validateCustomPolicy,
} from '@bastion-mcp/policy';
import { ApiError, NotFoundApiError } from '../errors';
import type { Row } from '../ports/store';
import { CrudService, type ReadCtx, type WriteCtx } from './crud';

export const policyRules = new CrudService({
  collection: 'policy_rules',
  targetType: 'policy_rule',
  action: 'policy_rule',
  configTopic: 'policy',
});

export const customPolicies = new CrudService({
  collection: 'custom_policies',
  targetType: 'custom_policy',
  action: 'custom_policy',
  configTopic: 'policy',
});

/** A rule is valid when it parses as a tool rule and compiles to Cedar (10.3). */
export const assertRuleCompiles = (fields: Record<string, unknown>): void => {
  const parsed = toolRuleRowSchema.safeParse({ ...fields, id: 'candidate' });
  if (!parsed.success) {
    throw new ApiError('invalid_rule', 'the rule is not valid', 422, {
      errors: parsed.error.issues.map((i) => ({
        path: `/${i.path.join('/')}`,
        message: i.message,
      })),
    });
  }
  try {
    compileRule(parsed.data);
  } catch (error) {
    throw new ApiError('invalid_rule', 'the rule cannot be compiled to Cedar', 422, {
      errors: [{ path: '/', message: error instanceof Error ? error.message : 'compile error' }],
    });
  }
};

export const createRule = (ctx: WriteCtx, body: Record<string, unknown>) => {
  assertRuleCompiles(body);
  return policyRules.create(ctx, body);
};

export const updateRule = async (ctx: WriteCtx, id: string, patch: Record<string, unknown>) => {
  const current = await ctx.tx.store.get('policy_rules', id);
  if (!current) throw new NotFoundApiError('policy_rule');
  assertRuleCompiles({ ...current, ...patch });
  return policyRules.update(ctx, id, patch);
};

const baseData = async (ctx: Pick<ReadCtx, 'deps'>): Promise<PolicyDataInput> =>
  ctx.deps.policy.data.load();

/** Strict-validates Cedar and runs the required tests against the current org data (10.3). */
export const validatePolicy = async (
  ctx: Pick<ReadCtx, 'deps'>,
  body: { cedar: string; tests: unknown[] },
) => validateCustomPolicy(body.cedar, body.tests, await baseData(ctx));

const assertValid = async (
  ctx: Pick<ReadCtx, 'deps'>,
  cedar: string,
  tests: unknown[],
): Promise<void> => {
  const report = await validatePolicy(ctx, { cedar, tests });
  if (report.ok) return;
  const failed = report.tests.filter((t) => !t.passed).map((t) => `test "${t.name}" failed`);
  throw new ApiError('invalid_policy', 'the custom policy did not validate', 422, {
    errors: [...report.errors, ...failed].map((message) => ({ path: '/cedar', message })),
  });
};

export const createCustomPolicy = async (
  ctx: WriteCtx,
  body: { name: string; cedar: string; tests: unknown[]; enabled: boolean },
): Promise<Row> => {
  await assertValid(ctx, body.cedar, body.tests);
  return customPolicies.create(ctx, body);
};

export const updateCustomPolicy = async (
  ctx: WriteCtx,
  id: string,
  patch: Record<string, unknown>,
): Promise<Row> => {
  const current = await ctx.tx.store.get('custom_policies', id);
  if (!current) throw new NotFoundApiError('custom_policy');
  const merged = { ...current, ...patch };
  if (patch.cedar !== undefined || patch.tests !== undefined) {
    await assertValid(ctx, String(merged.cedar), Array.isArray(merged.tests) ? merged.tests : []);
  }
  return customPolicies.update(ctx, id, patch);
};

/** Decision and determining policies for any principal, action and resource (10.4). */
export const simulatePolicy = (
  ctx: Pick<ReadCtx, 'deps'> & { engine: Parameters<typeof simulate>[0] },
  body: unknown,
) => simulate(ctx.engine, body, ctx.deps.clock.now());

import { z } from 'zod';
import { splitPolicies, validateStrict } from './cedar';
import { PolicyEngine } from './engine';
import { PolicyEvaluationError } from './errors';
import { simulate, simulateRequestSchema } from './simulate';
import { type PolicyDataInput, policyDataSchema } from './types';

/** A test case required by every custom policy (10.3): a simulated request and the expected decision. */
export const customPolicyTestSchema = z.object({
  name: z.string().min(1).max(200),
  request: simulateRequestSchema,
  expect: z.enum(['allow', 'deny']),
  /** Optional: the policy ids that must appear among the reasons. */
  expectReasons: z.array(z.string()).optional(),
});
export type CustomPolicyTest = z.infer<typeof customPolicyTestSchema>;

/** Body of `POST /api/v1/policies/validate`. */
export const validatePolicyRequestSchema = z.object({
  cedar: z
    .string()
    .min(1)
    .max(256 * 1024),
  tests: z.array(customPolicyTestSchema).default([]),
});

export type CustomPolicyTestResult = {
  name: string;
  passed: boolean;
  expected: 'allow' | 'deny';
  actual: 'allow' | 'deny' | 'error';
  reasons: string[];
  error?: string;
};

export type CustomPolicyReport = {
  ok: boolean;
  errors: string[];
  tests: CustomPolicyTestResult[];
};

export const CUSTOM_CANDIDATE_ID = 'candidate';

/**
 * Validates custom Cedar against the schema in strict mode and runs its test cases (10.3). The policy is
 * valid only when it parses, passes strict validation, has at least one test and every test passes. Tests
 * run against the role templates plus the candidate (and `base` data when given), so they can assert
 * interplay with the built-in policies.
 */
export const validateCustomPolicy = (
  cedarText: string,
  tests: readonly unknown[],
  base: PolicyDataInput = {},
): CustomPolicyReport => {
  const errors: string[] = [];
  let policies: ReturnType<typeof splitPolicies> = [];
  try {
    policies = splitPolicies(cedarText, 'candidate');
    if (policies.length === 0) errors.push('The policy text contains no policy');
  } catch (error) {
    errors.push(
      error instanceof PolicyEvaluationError
        ? (error.data.errors as string[] | undefined)?.join('; ') || error.message
        : String(error),
    );
    return { ok: false, errors, tests: [] };
  }
  const strict = validateStrict(Object.fromEntries(policies.map((p) => [p.id, p.text])));
  if (!strict.ok) errors.push(...strict.errors);
  const parsedTests = z.array(customPolicyTestSchema).safeParse(tests);
  if (!parsedTests.success) {
    errors.push(...parsedTests.error.issues.map((i) => `tests.${i.path.join('.')}: ${i.message}`));
  } else if (parsedTests.data.length === 0) {
    errors.push('At least one test case is required');
  }
  if (errors.length > 0 || !parsedTests.success) return { ok: false, errors, tests: [] };

  const baseData = policyDataSchema.parse(base);
  const engine = PolicyEngine.create({
    ...baseData,
    customPolicies: [...baseData.customPolicies, { id: CUSTOM_CANDIDATE_ID, cedar: cedarText }],
  });
  const results = parsedTests.data.map((test): CustomPolicyTestResult => {
    try {
      const outcome = simulate(engine, test.request);
      const reasonsOk = (test.expectReasons ?? []).every((id) =>
        outcome.reasons.some((r) => r === id || r.endsWith(`.${id}`)),
      );
      return {
        name: test.name,
        passed: outcome.decision === test.expect && reasonsOk,
        expected: test.expect,
        actual: outcome.decision,
        reasons: outcome.reasons,
      };
    } catch (error) {
      return {
        name: test.name,
        passed: false,
        expected: test.expect,
        actual: 'error',
        reasons: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  for (const failed of results.filter((r) => !r.passed)) {
    errors.push(`Test "${failed.name}" failed: expected ${failed.expected}, got ${failed.actual}`);
  }
  return { ok: errors.length === 0, errors, tests: results };
};

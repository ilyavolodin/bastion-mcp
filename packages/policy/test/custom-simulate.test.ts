import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  simulate,
  simulateRequestSchema,
  simulationContext,
  validateCustomPolicy,
  validatePolicyRequestSchema,
} from '../src';
import { admin, data, instMember, member, tool } from './fixtures';

const memberToolRequest = (extra: Record<string, unknown> = {}) => ({
  principal: member,
  action: 'callTool',
  resource: tool(instMember, 'delete_repository'),
  context: { clientId: 'cursor', hour: 3, weekday: 2 },
  ...extra,
});

const FORBID_NIGHT =
  '@id("no-nights")\nforbid (principal, action == Bastion::Action::"callTool", resource) when { context.hour < 6 };';

describe('10.4 simulate (POST /policies/simulate)', () => {
  const engine = PolicyEngine.create(data());

  it('10.4 returns the decision, reasons and the determining policy text for any principal and context', () => {
    const result = simulate(engine, memberToolRequest());
    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['use-inst-mem']);
    expect(result.determiningPolicies[0]?.text).toContain('use-inst-mem');
    expect(result.errors).toEqual([]);
  });

  it('10.4 explains a denial with the rule that did it', () => {
    const withRule = PolicyEngine.create(
      data({ rules: [{ id: 'r9', effect: 'forbid', what: { toolName: 'delete_*' } }] }),
    );
    const result = simulate(withRule, memberToolRequest({ action: 'seeTool' }));
    expect(result).toMatchObject({ decision: 'deny', reasons: ['rule-r9.see'] });
    expect(result.determiningPolicies).toHaveLength(1);
  });

  it('10.4 fills a neutral simulator context and accepts call arguments', () => {
    const request = memberToolRequest({ context: undefined, call: { owner: 'x' } });
    const parsed = simulateRequestSchema.parse(request);
    expect(parsed.context).toEqual({});
    expect(simulate(engine, request).decision).toBe('allow');
    const ctx = simulationContext({}, new Date('2026-10-01T10:00:00Z'));
    expect(ctx).toMatchObject({ clientId: 'simulator', ip: '127.0.0.1', hour: 10, weekday: 4 });
    expect(simulationContext({ hour: 1, weekday: 0, ip: '1.1.1.1' }).hour).toBe(1);
  });

  it('10.4 management actions simulate without a context', () => {
    const result = simulate(engine, {
      principal: admin,
      action: 'settings.edit',
      resource: { type: 'Org' },
    });
    expect(result.decision).toBe('allow');
  });

  it('17.1 untrusted simulate input is rejected by the zod boundary', () => {
    expect(() => simulate(engine, { principal: { kind: 'user' }, action: 'nope' })).toThrow();
    expect(() => simulate(engine, null)).toThrow();
  });
});

describe('10.3 validateCustomPolicy (POST /policies/validate)', () => {
  const nightTests = [
    {
      name: 'blocks night calls',
      request: memberToolRequest(),
      expect: 'deny',
    },
    {
      name: 'allows day calls',
      request: memberToolRequest({ context: { hour: 14 } }),
      expect: 'allow',
    },
  ];
  const base = data();

  it('10.3 accepts a strict-valid policy with passing tests', () => {
    const report = validateCustomPolicy(FORBID_NIGHT, nightTests, base);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tests.map((t) => t.passed)).toEqual([true, true]);
    expect(report.tests[0]?.reasons).toEqual(['custom-candidate.no-nights']);
  });

  it('10.3 requires at least one test case', () => {
    const report = validateCustomPolicy(FORBID_NIGHT, [], base);
    expect(report).toMatchObject({ ok: false });
    expect(report.errors.join()).toContain('At least one test case');
  });

  it('10.3 rejects policies that parse but fail strict validation against the schema', () => {
    const report = validateCustomPolicy(
      'permit (principal, action == Bastion::Action::"callTool", resource) when { resource.nope == 1 };',
      nightTests,
      base,
    );
    expect(report.ok).toBe(false);
    expect(report.errors.join()).toMatch(/nope/);
  });

  it('10.3 rejects text that does not parse and text with no policy', () => {
    expect(validateCustomPolicy('forbid (', nightTests).ok).toBe(false);
    const empty = validateCustomPolicy('// just a comment', nightTests);
    expect(empty.ok).toBe(false);
    expect(empty.errors.join()).toContain('no policy');
  });

  it('10.3 rejects policy templates', () => {
    const report = validateCustomPolicy(
      'permit (principal == ?principal, action, resource);',
      nightTests,
    );
    expect(report.ok).toBe(false);
  });

  it('10.3 a failing test case fails validation and says which', () => {
    const report = validateCustomPolicy(
      FORBID_NIGHT,
      [{ name: 'wrongly expects allow at night', request: memberToolRequest(), expect: 'allow' }],
      base,
    );
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain('wrongly expects allow at night');
    expect(report.tests[0]).toMatchObject({ passed: false, actual: 'deny' });
  });

  it('10.3 expectReasons must appear among the reasons', () => {
    const good = validateCustomPolicy(
      FORBID_NIGHT,
      [{ ...nightTests[0], expectReasons: ['no-nights'] }],
      base,
    );
    expect(good.ok).toBe(true);
    const bad = validateCustomPolicy(
      FORBID_NIGHT,
      [{ ...nightTests[0], expectReasons: ['other'] }],
      base,
    );
    expect(bad.ok).toBe(false);
  });

  it('10.3 malformed test cases are reported, and a test whose request cannot be evaluated fails', () => {
    expect(validateCustomPolicy(FORBID_NIGHT, [{ name: 'x' }], base).ok).toBe(false);
    const report = validateCustomPolicy(
      FORBID_NIGHT,
      [
        {
          name: 'action does not fit resource',
          request: { principal: member, action: 'callTool', resource: { type: 'Org' } },
          expect: 'deny',
        },
      ],
      base,
    );
    expect(report.ok).toBe(false);
    expect(report.tests[0]).toMatchObject({ actual: 'error', passed: false });
    expect(report.tests[0]?.error).toContain('does not apply');
  });

  it('10.3 tests run against the built-in policies as well, so interplay can be asserted', () => {
    const report = validateCustomPolicy(
      'forbid (principal, action == Bastion::Action::"settings.edit", resource);',
      [
        {
          name: 'even admins are blocked',
          request: { principal: admin, action: 'settings.edit', resource: { type: 'Org' } },
          expect: 'deny',
        },
      ],
    );
    expect(report.ok).toBe(true);
  });

  it('10.3 the API request schema bounds the policy size and defaults tests to empty', () => {
    expect(
      validatePolicyRequestSchema.parse({ cedar: 'permit (principal, action, resource);' }).tests,
    ).toEqual([]);
    expect(() => validatePolicyRequestSchema.parse({ cedar: '' })).toThrow();
  });
});

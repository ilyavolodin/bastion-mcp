import { describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES } from '../src';
import { cedar, policyToJson, splitPolicies } from '../src/cedar';
import {
  ALL_ACTIONS,
  INVOCATION_ACTIONS,
  isMcpAction,
  loadSchema,
  MANAGEMENT_ACTIONS,
  MCP_ACTIONS,
  NAMESPACE,
  VISIBILITY_ACTIONS,
} from '../src/schema';

describe('10.2 schema constants', () => {
  it('10.2 MCP actions are the invocation actions followed by the visibility actions', () => {
    expect(MCP_ACTIONS).toEqual([...INVOCATION_ACTIONS, ...VISIBILITY_ACTIONS]);
  });

  it('10.2 no action name repeats across MCP and management actions', () => {
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
    expect(ALL_ACTIONS).toHaveLength(MCP_ACTIONS.length + MANAGEMENT_ACTIONS.length);
  });

  it('10.2 isMcpAction separates MCP actions from management actions', () => {
    for (const action of MCP_ACTIONS) expect(isMcpAction(action)).toBe(true);
    for (const action of MANAGEMENT_ACTIONS) expect(isMcpAction(action)).toBe(false);
  });

  it('10.2 every action is declared in the Cedar schema under the Bastion namespace', () => {
    const schema = loadSchema() as unknown as Record<string, { actions: Record<string, unknown> }>;
    const declared = Object.keys(schema[NAMESPACE]?.actions ?? {});
    for (const action of ALL_ACTIONS) expect(declared).toContain(action);
  });
});

describe('10.3 role templates', () => {
  const entries = Object.entries(ROLE_TEMPLATES);

  it.each(entries)(
    '10.3 the %s template parses into policies that each carry an @id',
    (_name, text) => {
      const policies = splitPolicies(text, 'tpl');
      expect(policies.length).toBeGreaterThan(0);
      for (const policy of policies) {
        expect(policy.id).not.toMatch(/^tpl\./);
        expect(() => policyToJson(policy.text)).not.toThrow();
      }
    },
  );

  it('10.3 policy ids are unique across all templates', () => {
    const ids = entries.flatMap(([, text]) => splitPolicies(text, 'tpl').map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('10.3 the inactive-principal guard is the only forbid', () => {
    const forbids = entries.flatMap(([name, text]) =>
      splitPolicies(text, 'tpl')
        .filter((p) => policyToJson(p.text).effect === 'forbid')
        .map(() => name),
    );
    expect(forbids).toEqual(['guard']);
  });

  it('10.3 all templates together validate strictly against the schema', () => {
    const staticPolicies = Object.fromEntries(
      entries.flatMap(([, text]) => splitPolicies(text, 'tpl').map((p) => [p.id, p.text])),
    );
    const result = cedar.validate({
      schema: loadSchema(),
      policies: { staticPolicies },
      validationSettings: { mode: 'strict' },
    });
    expect(result.type).toBe('success');
    if (result.type === 'success') expect(result.validationErrors).toEqual([]);
  });
});

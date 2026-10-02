import { DEFAULT_LIMIT_RULES } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  compileRulesFor,
  defaultRules,
  matchRule,
  type Principal,
  parseRule,
  pointsFor,
  type Rule,
  subjectIdFor,
  subjectIdsFor,
} from '../src';

const principal: Principal = {
  orgId: 'org1',
  userId: 'u1',
  teamIds: ['t2', 't1'],
  roleIds: ['admin'],
  clientId: 'c1',
};

const rule = (over: Record<string, unknown>): Rule =>
  parseRule({
    id: 'r',
    name: 'R',
    subject: 'user',
    kind: 'rate',
    params: { points: 10, perSeconds: 60, burst: 0 },
    ...over,
  });

describe('14.1 rule model', () => {
  it('14.1 applies defaults for metric, action, subjectMatch, scope and enabled', () => {
    const r = rule({});
    expect(r).toMatchObject({
      metric: 'calls',
      action: 'reject',
      subjectMatch: 'each',
      scope: {},
      enabled: true,
    });
  });

  it('14.1 defaults concurrency leaseSeconds to 900', () => {
    const r = rule({ kind: 'concurrency', params: { max: 3 } });
    expect(r.kind === 'concurrency' && r.params.leaseSeconds).toBe(900);
  });

  it('14.1 rejects params that do not fit the kind', () => {
    expect(() =>
      rule({ kind: 'quota', params: { points: 5, perSeconds: 60, burst: 1 } }),
    ).toThrow();
    expect(() => rule({ kind: 'quota', params: { points: 5, period: 'year' } })).toThrow();
    expect(() => rule({ subject: 'galaxy' })).toThrow();
    expect(() => rule({ subjectMatch: [] })).toThrow();
  });

  it('14.1 accepts cost weights and warn action', () => {
    const r = rule({ cost: { bigquery__run_query: 10 }, action: 'warn' });
    expect(r.cost).toEqual({ bigquery__run_query: 10 });
    expect(r.action).toBe('warn');
  });
});

describe('14.3 default rules', () => {
  it('14.3 are the documented defaults as data', () => {
    const rules = defaultRules();
    const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
    expect(byId['default:user-calls']?.params).toEqual(DEFAULT_LIMIT_RULES.userCalls);
    expect(byId['default:user-concurrency']?.params).toEqual(DEFAULT_LIMIT_RULES.userConcurrency);
    expect(byId['default:service-account-calls']?.params).toEqual(
      DEFAULT_LIMIT_RULES.serviceAccountCalls,
    );
    const sampling = byId['default:user-sampling'];
    expect(sampling?.kind).toBe('quota');
    expect(sampling?.metric).toBe('samplingRequests');
    expect(sampling?.params).toEqual({ points: 200, period: 'day' });
    for (const r of rules) expect(parseRule(r)).toEqual(r);
  });
});

describe('14.1 subjects', () => {
  it('14.1 subjectIdFor yields the counter subject per subject kind', () => {
    expect(subjectIdFor(rule({ subject: 'user' }), principal)).toBe('u1');
    expect(subjectIdFor(rule({ subject: 'org' }), principal)).toBe('org1');
    expect(subjectIdFor(rule({ subject: 'client' }), principal)).toBe('c1');
    expect(subjectIdFor(rule({ subject: 'serviceAccount' }), principal)).toBeUndefined();
    expect(
      subjectIdFor(rule({ subject: 'serviceAccount' }), { orgId: 'o', serviceAccountId: 's' }),
    ).toBe('s');
  });

  it('14.1 each team or role the caller belongs to gets its own counter', () => {
    expect(subjectIdsFor(rule({ subject: 'team' }), principal)).toEqual(['t1', 't2']);
    expect(subjectIdsFor(rule({ subject: 'role' }), principal)).toEqual(['admin']);
  });

  it('14.1 specific subject ids restrict the rule to those subjects', () => {
    expect(subjectIdsFor(rule({ subject: 'team', subjectMatch: ['t2', 'x'] }), principal)).toEqual([
      't2',
    ]);
    expect(
      subjectIdsFor(rule({ subject: 'user', subjectMatch: ['someone-else'] }), principal),
    ).toEqual([]);
  });
});

describe('14.1 compileRulesFor', () => {
  const rules = [
    rule({ id: 'a' }),
    rule({ id: 'disabled', enabled: false }),
    rule({ id: 'sa', subject: 'serviceAccount' }),
    rule({ id: 'other-user', subjectMatch: ['u9'] }),
    rule({ id: 'inst', scope: { installationId: 'i1' } }),
    rule({ id: 'inst-missing', scope: { installationId: 'i9' } }),
    rule({ id: 'cat', scope: { catalogEntryId: 'c1' } }),
    rule({ id: 'tool', scope: { tool: 'bq__*' } }),
  ];

  it('14.1 keeps only rules that can match the caller on this endpoint', () => {
    const ids = compileRulesFor(
      principal,
      { installationIds: ['i1'], catalogEntryIds: ['c1'] },
      rules,
    ).map((r) => r.id);
    expect(ids).toEqual(['a', 'inst', 'cat', 'tool']);
  });

  it('14.1 drops scoped rules when the endpoint has no such installation or entry', () => {
    expect(compileRulesFor(principal, {}, rules).map((r) => r.id)).toEqual(['a', 'tool']);
  });
});

describe('14.1 matchRule', () => {
  const op = (over: Record<string, unknown> = {}) => ({
    principal,
    method: 'tools/call',
    installationId: 'i1',
    toolName: 'bq__run_query',
    ...over,
  });

  it('14.1 matches tool-name globs with picomatch', () => {
    expect(matchRule(rule({ scope: { tool: 'bq__*' } }), op())).toBe(true);
    expect(matchRule(rule({ scope: { tool: 'gh__*' } }), op())).toBe(false);
    expect(matchRule(rule({ scope: { tool: 'bq__*' } }), op({ toolName: undefined }))).toBe(false);
    expect(matchRule(rule({ scope: { tool: '{bq,gh}__*' } }), op({ toolName: 'gh__x' }))).toBe(
      true,
    );
  });

  it('14.1 matches installation, catalog entry and method scopes', () => {
    expect(matchRule(rule({ scope: { installationId: 'i1' } }), op())).toBe(true);
    expect(matchRule(rule({ scope: { installationId: 'i2' } }), op())).toBe(false);
    expect(matchRule(rule({ scope: { catalogEntryId: 'c' } }), op({ catalogEntryId: 'c' }))).toBe(
      true,
    );
    expect(matchRule(rule({ scope: { catalogEntryId: 'c' } }), op())).toBe(false);
    expect(matchRule(rule({ scope: { method: 'tools/call' } }), op())).toBe(true);
    expect(matchRule(rule({ scope: { method: 'resources/read' } }), op())).toBe(false);
  });

  it('14.1 a disabled rule never matches', () => {
    expect(matchRule(rule({ enabled: false }), op())).toBe(false);
  });

  it('14.1 a non-calls metric only matches operations that carry an amount', () => {
    const r = rule({ metric: 'samplingRequests' });
    expect(matchRule(r, op())).toBe(false);
    expect(matchRule(r, op({ amounts: { samplingRequests: 1 } }))).toBe(true);
  });

  it('14.1 cost weights set the points per tool, default 1', () => {
    const r = rule({ cost: { bq__run_query: 10 } });
    expect(pointsFor(r, op())).toBe(10);
    expect(pointsFor(r, op({ toolName: 'other' }))).toBe(1);
    expect(pointsFor(rule({ metric: 'bytesOut' }), op({ amounts: { bytesOut: 10.2 } }))).toBe(11);
  });
});

import { ROUTE_ACTIONS, type RouteAction } from '@bastion-mcp/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandRouteString } from '../src/framework/route-table';
import { installationsCases } from './authz/installations.cases';
import { buildTestApi, type TestApi } from './helpers/harness';
import type { ActorName } from './helpers/world';

/** 23.3 authorization table for the installation area: allow and deny per role from `ROUTE_ACTIONS`. */
type Expectation = 'allow' | 'deny' | 'unauthenticated';
const expectedFor = (rule: RouteAction, actor: ActorName, scope: 'own' | 'other'): Expectation => {
  const g = rule.grants;
  const grant = (v: 'allow' | 'scoped' | 'deny'): Expectation =>
    v === 'allow' ? 'allow' : v === 'deny' ? 'deny' : scope === 'own' ? 'allow' : 'deny';
  switch (actor) {
    case 'admin':
      return grant(g.admin);
    case 'auditor':
      return grant(g.auditor);
    case 'managerOwn':
    case 'managerOther':
      return grant(g.manager);
    case 'member':
      return grant(g.member);
    case 'service':
      // Service accounts act on installations they own, never on the org-level personal routes (10.1).
      return rule.id === 'installations.personal' ? 'deny' : grant(g.member);
    case 'anonymous':
      return 'unauthenticated';
  }
};

const ROWS: Array<[ActorName, 'own' | 'other']> = [
  ['admin', 'own'],
  ['managerOwn', 'own'],
  ['managerOther', 'other'],
  ['member', 'own'],
  ['member', 'other'],
  ['auditor', 'other'],
  ['service', 'own'],
  ['anonymous', 'own'],
];

let api: TestApi;
beforeAll(async () => {
  api = await buildTestApi();
});
afterAll(async () => {
  await api.close();
});

const RULES = new Set([
  'installations.personal',
  'installations.from-entry',
  'installations.team',
  'installations.manage',
  'overrides.installation',
  'overrides.catalog',
  'drift.write',
  'auto-install.team',
  'auto-install.org',
]);
const ruleOf = (id: string) => {
  const rule = ROUTE_ACTIONS.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown rule ${id}`);
  return rule;
};

describe('23.3 installation routes are all covered by the authorization table', () => {
  it('23.3 has a case for every route string of the area rules', () => {
    const missing: string[] = [];
    for (const rule of ROUTE_ACTIONS.filter((r) => RULES.has(r.id))) {
      for (const route of rule.routes.flatMap(expandRouteString)) {
        if (!installationsCases.some((c) => c.rule === rule.id && c.route === route)) {
          missing.push(`${rule.id}: ${route}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('23.3 installation routes: allow and deny per role', () => {
  for (const c of installationsCases) {
    for (const [actor, scope] of ROWS) {
      const expected = expectedFor(ruleOf(c.rule), actor, scope);
      it(`23.3 ${c.rule} ${c.route} as ${actor}/${scope} is ${expected}`, async () => {
        const fresh = await buildTestApi();
        try {
          const req = c.request(scope, actor);
          const res = await fresh.call(actor, req.method, req.url, {
            ...(req.body === undefined ? {} : { body: req.body }),
            ...(req.query ? { query: req.query } : {}),
          });
          if (expected === 'unauthenticated') expect(res.status).toBe(401);
          else if (expected === 'deny') expect(res.status).toBe(403);
          else expect([401, 403]).not.toContain(res.status);
        } finally {
          await fresh.close();
        }
      });
    }
  }
});

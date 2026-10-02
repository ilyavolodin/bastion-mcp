import { ROUTE_ACTIONS } from '@bastion-mcp/policy';
import { describe, expect, it } from 'vitest';
import { expandRouteString } from '../src/framework/route-table';
import { registryCases } from './authz/registry.cases';
import { buildTestApi } from './helpers/harness';
import type { ActorName } from './helpers/world';

/** 23.3 table-driven authorization for area C, driven by ROUTE_ACTIONS (the real PolicyEngine). */

type Row = { actor: ActorName; scope: 'own' | 'other'; expect: 'allow' | 'deny' };

const rowsFor = (grants: {
  admin: string;
  manager: string;
  member: string;
  auditor: string;
}): Row[] => {
  const scoped = (g: string, scope: 'own' | 'other'): 'allow' | 'deny' =>
    g === 'allow' || (g === 'scoped' && scope === 'own') ? 'allow' : 'deny';
  return [
    { actor: 'admin', scope: 'own', expect: scoped(grants.admin, 'own') },
    { actor: 'managerOwn', scope: 'own', expect: scoped(grants.manager, 'own') },
    { actor: 'managerOther', scope: 'other', expect: scoped(grants.manager, 'other') },
    { actor: 'member', scope: 'own', expect: scoped(grants.member, 'own') },
    { actor: 'member', scope: 'other', expect: scoped(grants.member, 'other') },
    { actor: 'auditor', scope: 'own', expect: scoped(grants.auditor, 'own') },
  ];
};

describe('23.3 authorization table: registry, policies, guards, limits, secrets', () => {
  it('23.3 every route string of the area rules has a case', () => {
    const covered = new Set(registryCases.map((c) => `${c.rule} ${c.route}`));
    const rules = ROUTE_ACTIONS.filter((r) =>
      [
        'registry.sources.write',
        'registry.install',
        'registry.requests.decide',
        'policies.write',
        'guards.write',
        'limits.write',
        'secrets.org',
        'secrets.team',
        'secrets.user',
      ].includes(r.id),
    );
    const missing = rules.flatMap((r) =>
      r.routes.flatMap(expandRouteString).filter((route) => !covered.has(`${r.id} ${route}`)),
    );
    expect(missing).toEqual([]);
  });

  for (const c of registryCases) {
    const rule = ROUTE_ACTIONS.find((r) => r.id === c.rule);
    if (!rule) throw new Error(`unknown rule ${c.rule}`);
    for (const row of rowsFor(rule.grants)) {
      it(`23.3 ${c.route} [${c.rule}] ${row.actor}/${row.scope} -> ${row.expect}`, async () => {
        const api = await buildTestApi();
        const req = c.request(row.scope, row.actor);
        const res = await api.call(row.actor, req.method, req.url, {
          ...(req.body === undefined ? {} : { body: req.body }),
          ...(req.query ? { query: req.query } : {}),
        });
        await api.close();
        if (row.expect === 'deny') expect(res.status).toBe(403);
        else expect([401, 403]).not.toContain(res.status);
      });
    }
    it(`23.3 ${c.route} [${c.rule}] anonymous -> 401`, async () => {
      const api = await buildTestApi();
      const req = c.request('own', 'anonymous');
      const res = await api.call('anonymous', req.method, req.url, {
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.query ? { query: req.query } : {}),
      });
      await api.close();
      expect(res.status).toBe(401);
    });
  }
});

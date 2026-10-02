import { ROUTE_ACTIONS } from '@bastion-mcp/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandRouteString } from '../src/framework/route-table';
import { catalogCases } from './authz/catalog.cases';
import { buildTestApi, type TestApi } from './helpers/harness';
import type { ActorName } from './helpers/world';

/**
 * Table-driven authorization for the catalog routes (23.3) with the real PolicyEngine. Rows follow the
 * ROUTE_ACTIONS grants: `scoped` allows the in-scope actor and denies the out-of-scope one.
 */
type Row = { actor: ActorName; scope: 'own' | 'other'; allowed: boolean };

const rowsFor = (grants: Record<'admin' | 'manager' | 'member' | 'auditor', string>): Row[] => [
  { actor: 'admin', scope: 'own', allowed: grants.admin !== 'deny' },
  { actor: 'managerOwn', scope: 'own', allowed: grants.manager !== 'deny' },
  { actor: 'managerOther', scope: 'other', allowed: grants.manager === 'allow' },
  { actor: 'member', scope: 'own', allowed: grants.member !== 'deny' },
  { actor: 'member', scope: 'other', allowed: grants.member === 'allow' },
  { actor: 'auditor', scope: 'own', allowed: grants.auditor !== 'deny' },
  { actor: 'service', scope: 'own', allowed: grants.member !== 'deny' },
];

let api: TestApi;
beforeAll(async () => {
  api = await buildTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('23.3 catalog routes: authorization table', () => {
  const rules = new Map(ROUTE_ACTIONS.map((r) => [r.id, r]));

  it('23.3 every catalog, store and plugin-source route of ROUTE_ACTIONS has a case', () => {
    const mine = [
      'catalog.read',
      'catalog.create.team',
      'catalog.create.org',
      'catalog.update',
      'catalog.delete',
      'catalog.publish.team',
      'catalog.publish.org',
      'plugin.approve-executable',
      'plugin-sources.write',
    ];
    const wanted = mine.flatMap((id) =>
      (rules.get(id)?.routes ?? [])
        .flatMap(expandRouteString)
        .filter((r) => !r.includes('/marketplaces'))
        .map((r) => `${id} ${r}`),
    );
    wanted.push('org.view GET /plugin-sources');
    const have = new Set(catalogCases.map((c) => `${c.rule} ${c.route}`));
    expect(wanted.filter((w) => !have.has(w))).toEqual([]);
  });

  for (const c of catalogCases) {
    const rule = rules.get(c.rule);
    for (const row of rowsFor(
      rule?.grants ?? { admin: 'deny', manager: 'deny', member: 'deny', auditor: 'deny' },
    )) {
      const verdict = row.allowed ? 'is allowed' : 'is denied';
      it(`10.1 ${c.rule} ${c.route}: ${row.actor} (${row.scope}) ${verdict}`, async () => {
        const req = c.request(row.scope, row.actor);
        const res = await api.call(row.actor, req.method, req.url, {
          ...(req.body === undefined ? {} : { body: req.body }),
          ...(req.query ? { query: req.query } : {}),
        });
        if (row.allowed) {
          expect([401, 403]).not.toContain(res.status);
        } else {
          expect(res.status).toBe(
            c.scopedDeny !== undefined && rule?.grants.member !== 'deny' ? c.scopedDeny : 403,
          );
        }
      });
    }
    it(`9.3 ${c.rule} ${c.route}: unauthenticated callers get 401`, async () => {
      const req = c.request('own', 'admin');
      const res = await api.call('anonymous', req.method, req.url, {
        ...(req.body === undefined ? {} : { body: req.body }),
      });
      expect(res.status).toBe(401);
    });
  }
});

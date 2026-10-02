import {
  type Grant,
  ROUTE_ACTIONS,
  type RouteAction,
  serviceAccountGrant,
} from '@bastion-mcp/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandRouteString } from '../src/framework/route-table';
import type { AuthzCase } from './authz/types';
import { buildTestApi, type TestApi } from './helpers/harness';
import type { ActorName } from './helpers/world';

/** Every `test/authz/*.cases.ts` module exports one array of cases (the area forks' contributions). */
type GlobMeta = {
  glob: <T>(pattern: string, options: { eager: true }) => Record<string, T>;
};
const modules = (import.meta as unknown as GlobMeta).glob<Record<string, AuthzCase[]>>(
  './authz/*.cases.ts',
  { eager: true },
);
const CASES: AuthzCase[] = Object.values(modules).flatMap((m) => Object.values(m).flat());

type Expectation = 'allow' | 'deny' | 'unauthenticated';
type Row = {
  actor: ActorName;
  scope: 'own' | 'other';
  expect: Expectation;
  /** The denial comes from a `scoped` grant (a filtered list or a hidden resource may answer 200 or 404). */
  scoped?: boolean;
};

const resolve = (grant: Grant, scope: 'own' | 'other'): Expectation =>
  grant === 'allow' ? 'allow' : grant === 'deny' ? 'deny' : scope === 'own' ? 'allow' : 'deny';

/**
 * 23.3 expectation matrix derived from the policy table (10.1): admin, manager of the own team, manager of
 * another team, member (own and foreign resource), auditor, service account (a member of team A) and an
 * unauthenticated caller.
 */
export const rowsFor = (rule: RouteAction): Row[] => {
  const g = rule.grants;
  const rows: Row[] = [
    { actor: 'admin', scope: 'own', expect: resolve(g.admin, 'own') },
    { actor: 'managerOwn', scope: 'own', expect: resolve(g.manager, 'own') },
    {
      actor: 'managerOther',
      scope: 'other',
      expect: resolve(g.manager, 'other'),
      scoped: g.manager === 'scoped',
    },
    { actor: 'member', scope: 'own', expect: resolve(g.member, 'own') },
    {
      actor: 'member',
      scope: 'other',
      expect: resolve(g.member, 'other'),
      scoped: g.member === 'scoped',
    },
    {
      actor: 'auditor',
      scope: 'other',
      expect: resolve(g.auditor, 'other'),
      scoped: g.auditor === 'scoped',
    },
    {
      actor: 'service',
      scope: 'own',
      expect: resolve(serviceAccountGrant(rule), 'own'),
    },
    { actor: 'anonymous', scope: 'own', expect: 'unauthenticated' },
  ];
  if (g.admin === 'scoped') rows.push({ actor: 'admin', scope: 'other', expect: 'deny' });
  return rows;
};

const ruleOf = (id: string): RouteAction => {
  const rule = ROUTE_ACTIONS.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown rule ${id}`);
  return rule;
};

describe('23.3 every route of 17.2 has an authorization case', () => {
  it('23.3 covers every (rule, route) pair of ROUTE_ACTIONS', () => {
    const have = new Set(CASES.map((c) => `${c.rule}|${c.route}`));
    const missing = ROUTE_ACTIONS.flatMap((r) =>
      r.routes.flatMap(expandRouteString).map((route) => `${r.id}|${route}`),
    ).filter((key) => !have.has(key));
    expect(missing).toEqual([]);
  });

  it('23.3 has no case for a route the table does not list', () => {
    const listed = new Set(
      ROUTE_ACTIONS.flatMap((r) =>
        r.routes.flatMap(expandRouteString).map((rt) => `${r.id}|${rt}`),
      ),
    );
    const extra = CASES.map((c) => `${c.rule}|${c.route}`).filter((key) => !listed.has(key));
    expect(extra).toEqual([]);
  });
});

describe('23.3 authorization table (real PolicyEngine)', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await buildTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  for (const c of CASES) {
    const rule = ruleOf(c.rule);
    describe(`${c.rule}: ${c.route}`, () => {
      for (const row of rowsFor(rule)) {
        it(`10.1 ${row.actor} (${row.scope}) is ${row.expect === 'unauthenticated' ? 'rejected with 401' : row.expect === 'allow' ? 'authorized' : 'denied with 403'}`, async () => {
          api.reset();
          const req = c.request(row.scope, row.actor);
          const res = await api.call(row.actor, req.method, req.url, {
            ...(req.query ? { query: req.query } : {}),
            ...(req.body === undefined ? {} : { body: req.body }),
          });
          const detail = JSON.stringify(res.body).slice(0, 300);
          const body = res.body as { detail?: string; code?: string } | null;
          expect(body?.detail, `the request hit no route: ${req.method} ${req.url}`).not.toBe(
            'route not found',
          );
          if (row.expect === 'unauthenticated') {
            expect(res.status, detail).toBe(401);
          } else if (row.expect === 'deny') {
            if (row.scoped && c.scopedDeny !== undefined) {
              expect(res.status, detail).toBe(c.scopedDeny);
            } else {
              expect(res.status, detail).toBe(403);
              expect(body?.code, detail).toBe('forbidden');
            }
          } else {
            expect([401, 403], `${res.status} ${detail}`).not.toContain(res.status);
            expect(res.status, detail).toBeLessThan(500);
          }
        });
      }
    });
  }
});

import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_ACTIONS,
  PolicyEngine,
  type ResourceData,
  ROUTE_ACTIONS,
  type RouteAction,
  type RouteRole,
  serviceAccountGrant,
} from '../src';
import {
  data,
  entryResource,
  instAdmin,
  instAuditor,
  installationResource,
  instManager,
  instMember,
  instOther,
  instService,
  instTeam,
  orgResource,
  ROLES,
  serviceAccount,
  teamResource,
  userResource,
} from './fixtures';

const engine = PolicyEngine.create(data());

const entryFor = (id: string): ResourceData =>
  id === 'e-t'
    ? entryResource('e-t', { ownerTeamId: 't', visibility: { teamIds: ['t'] }, risk: 'medium' })
    : id === 'e-u'
      ? entryResource('e-u', { ownerTeamId: 'u', visibility: { teamIds: ['u'] }, risk: 'high' })
      : entryResource('e-org', { visibility: { org: true } });

const scopeResource = (row: RouteAction, role: RouteRole, which: 'in' | 'out'): ResourceData => {
  const inScope = which === 'in';
  switch (row.resource) {
    case 'Org':
      return orgResource();
    case 'Team':
      return teamResource(inScope ? 't' : 'u');
    case 'CatalogEntry':
      if (!inScope) return entryFor('e-u');
      return role === 'manager' || role === 'admin' ? entryFor('e-t') : entryFor('e-org');
    case 'Installation': {
      if (!inScope) return installationResource(instOther);
      const own = {
        admin: instAdmin,
        manager: instTeam,
        member: instMember,
        auditor: instAuditor,
      }[role];
      return installationResource(own);
    }
    case 'User': {
      const selfIds = { admin: 'admin1', manager: 'mgr1', member: 'mem1', auditor: 'aud1' };
      if (!inScope) return userResource('oth1', ['u']);
      if (role === 'manager' && row.id !== 'secrets.user') return userResource('mem1', ['t']);
      return userResource(selfIds[role], role === 'admin' || role === 'auditor' ? [] : ['t']);
    }
    default:
      throw new Error(`row ${row.id} has no resource`);
  }
};

const rows = ROUTE_ACTIONS.filter((r) => r.action !== null);
const roles = Object.keys(ROLES) as RouteRole[];

describe('17.2, 23.3 route-action table', () => {
  it('17.2 every management action in the schema is used by a route row or is documented as covered', () => {
    const used = new Set(rows.map((r) => r.action));
    for (const action of MANAGEMENT_ACTIONS) expect(used.has(action), action).toBe(true);
  });

  it('17.2 every row declares routes and a resource unless it is a self-service row', () => {
    for (const row of ROUTE_ACTIONS) {
      expect(row.routes.length, row.id).toBeGreaterThan(0);
      expect(row.action === null, row.id).toBe(row.resource === null);
    }
    expect(new Set(ROUTE_ACTIONS.map((r) => r.id)).size).toBe(ROUTE_ACTIONS.length);
  });

  describe('23.3 allow and deny per role for every route row', () => {
    for (const row of rows) {
      for (const role of roles) {
        const grant = row.grants[role];
        it(`10.1 ${row.action} on ${row.resource} (${row.id}) as ${role}: ${grant}`, () => {
          const principal = ROLES[role];
          const action = row.action;
          if (action === null) throw new Error('unreachable');
          const inside = engine.authorize({
            principal,
            action,
            resource: scopeResource(row, role, 'in'),
          });
          expect(inside.decision, `in scope: ${inside.reasons.join(',')}`).toBe(
            grant === 'deny' ? 'deny' : 'allow',
          );
          const outside = engine.authorize({
            principal,
            action,
            resource: scopeResource(row, role, 'out'),
          });
          expect(outside.decision, `out of scope: ${outside.reasons.join(',')}`).toBe(
            grant === 'allow' ? 'allow' : 'deny',
          );
          if (inside.decision === 'allow') expect(inside.reasons.length).toBeGreaterThan(0);
        });
      }
    }
  });

  describe('10.1 service accounts hold member capabilities for their own installations only', () => {
    const serviceResource = (row: RouteAction, which: 'in' | 'out'): ResourceData => {
      if (row.resource === 'Installation')
        return installationResource(which === 'in' ? instService : instOther);
      if (row.resource === 'User') return userResource(which === 'in' ? 'sa1' : 'oth1', ['t']);
      return scopeResource(row, 'member', which);
    };
    for (const row of rows) {
      const grant = serviceAccountGrant(row);
      it(`10.1 ${row.action} on ${row.resource} (${row.id}) as service account: ${grant}`, () => {
        const action = row.action;
        if (action === null) throw new Error('unreachable');
        const inside = engine.authorize({
          principal: serviceAccount,
          action,
          resource: serviceResource(row, 'in'),
        });
        expect(inside.decision, inside.reasons.join(',')).toBe(grant === 'deny' ? 'deny' : 'allow');
      });
    }

    it('10.1 user-only capabilities are denied to service accounts in the table', () => {
      const denied = rows.filter(
        (r) => serviceAccountGrant(r) === 'deny' && r.grants.member !== 'deny',
      );
      expect(denied.map((r) => r.id).sort()).toEqual([
        'installations.personal',
        'logs.user',
        'registry.install',
        'secrets.user',
      ]);
    });
  });

  it('10.1 manager grants hold only for teams the manager manages', () => {
    const decision = engine.authorize({
      principal: ROLES.manager,
      action: 'user.manage',
      resource: teamResource('u'),
    });
    expect(decision.decision).toBe('deny');
  });

  it('10.1 manager of own installation but not of a member installation outside the team', () => {
    expect(
      engine.authorize({
        principal: ROLES.manager,
        action: 'installation.manage',
        resource: installationResource(instManager),
      }).decision,
    ).toBe('allow');
    expect(
      engine.authorize({
        principal: ROLES.manager,
        action: 'installation.manage',
        resource: installationResource(instMember),
      }).decision,
    ).toBe('deny');
  });
});

import { ROUTE_ACTIONS, type RouteAction } from '@bastion-mcp/policy';
import type { RouteDefinition } from './route';

/** Routes outside the 17.2 table that need no Cedar decision (authenticated, own data only). */
const EXTRA_SELF_ROUTES: readonly string[] = ['GET /events'];

const ruleById = new Map<string, RouteAction>(ROUTE_ACTIONS.map((r) => [r.id, r]));

/** `GET/POST /endpoints` -> two entries; query strings dropped (`GET /calls?team=` -> `GET /calls`). */
export const expandRouteString = (route: string): string[] => {
  const space = route.indexOf(' ');
  const methods = route.slice(0, space).split('/');
  const path = route.slice(space + 1).split('?')[0] ?? '';
  return methods.map((m) => `${m} ${path}`);
};

const coverage = new Map<string, Set<string>>();
for (const rule of ROUTE_ACTIONS) {
  coverage.set(rule.id, new Set(rule.routes.flatMap(expandRouteString)));
}

export const ruleOf = (id: string): RouteAction | undefined => ruleById.get(id);

/** Every `(method, path)` the policy table lists, for the table-driven authorization test (23.3). */
export const tableRoutes = (): Array<{ rule: RouteAction; method: string; path: string }> =>
  ROUTE_ACTIONS.flatMap((rule) =>
    rule.routes.flatMap(expandRouteString).map((entry) => {
      const [method = '', path = ''] = entry.split(' ');
      return { rule, method, path };
    }),
  );

export class RouteDeclarationError extends Error {}

/**
 * Startup check (17.1): every route declares its authorization, names rules that exist, and is listed in the
 * policy table under each rule it names. A route without a declaration fails startup.
 */
export const assertRouteDeclarations = (routes: readonly RouteDefinition[]): void => {
  const seen = new Set<string>();
  for (const route of routes) {
    const label = `${route.method} ${route.url}`;
    if (!route.authz) {
      throw new RouteDeclarationError(`route ${label} has no authorization declaration`);
    }
    if (seen.has(label)) throw new RouteDeclarationError(`route ${label} is registered twice`);
    seen.add(label);
    const rules =
      route.authz.kind === 'resource'
        ? route.authz.rules
        : route.authz.kind === 'filter'
          ? [route.authz.rule]
          : ['self'];
    if (route.authz.kind === 'self' && EXTRA_SELF_ROUTES.includes(label)) continue;
    for (const id of rules) {
      if (!ruleById.has(id)) {
        throw new RouteDeclarationError(`route ${label} names unknown authorization rule ${id}`);
      }
      if (!coverage.get(id)?.has(label)) {
        throw new RouteDeclarationError(
          `route ${label} is not listed under authorization rule ${id} in ROUTE_ACTIONS`,
        );
      }
    }
  }
};

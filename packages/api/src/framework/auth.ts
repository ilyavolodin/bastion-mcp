import {
  assertCsrf,
  buildChallenge,
  CSRF_HEADER,
  CsrfError,
  InsufficientScopeError,
  isStateChanging,
  type Principal,
  parseCookies,
  SESSION_COOKIE,
} from '@bastion-mcp/auth';
import { SCOPES } from '@bastion-mcp/core';
import type { PrincipalData, ResourceData } from '@bastion-mcp/policy';
import type { FastifyRequest } from 'fastify';
import { ForbiddenApiError } from '../errors';
import type { ApiDeps } from '../ports';

const header = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const requestUrl = (req: FastifyRequest, deps: ApiDeps): string =>
  new URL(req.url, deps.config.baseUrl).toString();

/**
 * 17.1 authentication: `Authorization: Bearer` (PAT or OAuth token for resource `https://<host>/api`) or the
 * browser session cookie plus the CSRF header on state-changing calls (9.2).
 */
export const authenticate = async (req: FastifyRequest, deps: ApiDeps): Promise<Principal> => {
  const authorization = header(req, 'authorization');
  const url = requestUrl(req, deps);
  const mutating = isStateChanging(req.method);
  if (authorization) {
    const principal = await deps.auth.tokens.verify(authorization, url);
    assertScope(principal, mutating, url, deps);
    return principal;
  }
  const sid = parseCookies(header(req, 'cookie'))[SESSION_COOKIE];
  if (sid) {
    const principal = await deps.auth.sessions.authenticate(sid);
    if (principal) {
      if (mutating) await assertSessionCsrf(req, deps, sid);
      return principal;
    }
  }
  // No usable credential: the verifier raises the 401 with the exact challenge (6.9).
  return deps.auth.tokens.verify(undefined, url);
};

/** 9.2: double submit (cookie equals header) and the token must be the one issued with this session. */
const assertSessionCsrf = async (
  req: FastifyRequest,
  deps: ApiDeps,
  sid: string,
): Promise<void> => {
  const presented = header(req, CSRF_HEADER);
  assertCsrf(header(req, 'cookie'), presented);
  if (!(await deps.auth.sessions.checkCsrf(sid, presented))) throw new CsrfError();
};

const assertScope = (principal: Principal, mutating: boolean, url: string, deps: ApiDeps): void => {
  const scopes = principal.scopes;
  const ok = mutating
    ? scopes.includes(SCOPES.apiWrite)
    : scopes.includes(SCOPES.apiRead) || scopes.includes(SCOPES.apiWrite);
  if (ok) return;
  const required = mutating ? SCOPES.apiWrite : SCOPES.apiRead;
  throw new InsufficientScopeError(
    `the token needs the ${required} scope`,
    buildChallenge({
      surface: 'api',
      baseUrl: deps.config.baseUrl,
      pathname: new URL(url).pathname,
      error: 'insufficient_scope',
    }),
    required,
  );
};

/** The caller as the policy engine models it (10.1). */
export const toPolicyPrincipal = (principal: Principal): PrincipalData => {
  if (principal.type === 'service') {
    const team = principal.teams[0];
    if (!team) throw new ForbiddenApiError('service account has no team');
    return {
      kind: 'service',
      id: principal.id,
      active: principal.active,
      team: { id: team.teamId },
    };
  }
  return {
    kind: 'user',
    id: principal.id,
    role: principal.orgRole,
    active: principal.active,
    emailDomain: '',
    teams: principal.teams.map((t) => ({ id: t.teamId, role: t.role })),
  };
};

export const ORG_RESOURCE: ResourceData = { type: 'Org' };
export const teamResource = (id: string): ResourceData => ({ type: 'Team', id });

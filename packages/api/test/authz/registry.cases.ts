import type { ActorName } from '../helpers/world';
import { W } from '../helpers/world';
import type { AuthzCase, Req } from './types';

/** Authorization cases of area C: registry, policies, guards, limits and secrets (23.3). */

const SRC = 'src-official';
const NAME = encodeURIComponent('io.github.acme/remote-docs');

const fixed = (rule: string, route: string, req: Req): AuthzCase => ({
  rule,
  route,
  request: () => req,
});

const ownUserId = (actor: ActorName): string =>
  ({
    admin: W.admin,
    managerOwn: W.managerA,
    managerOther: W.managerB,
    member: W.memberA,
    auditor: W.auditor,
    service: W.svc,
    anonymous: W.admin,
  })[actor];

/** `own`: the actor's own user; `other`: somebody else's. */
const userOwner = (scope: 'own' | 'other', actor: ActorName): string =>
  scope === 'own' ? ownUserId(actor) : actor === 'member' ? W.memberB : W.memberA;

/** `own`: team A (managers of A, members of A); `other`: a team the actor does not manage. */
const teamOwner = (scope: 'own' | 'other', actor: ActorName): string =>
  scope === 'own' ? W.teamA : actor === 'member' ? W.teamB : W.teamA;

const orgRule = (rule: string, route: string, req: Req) => fixed(rule, route, req);

const SECRET_BODY = { value: 'v' };

export const registryCases: AuthzCase[] = [
  // registry.sources.write
  orgRule('registry.sources.write', 'POST /registry-sources', {
    method: 'POST',
    url: '/registry-sources',
    body: { name: 'Authz', baseUrl: 'https://authz.example.com' },
  }),
  orgRule('registry.sources.write', 'PATCH /registry-sources/{id}', {
    method: 'PATCH',
    url: `/registry-sources/${SRC}`,
    body: { name: 'Renamed' },
  }),
  orgRule('registry.sources.write', 'DELETE /registry-sources/{id}', {
    method: 'DELETE',
    url: `/registry-sources/${SRC}`,
  }),
  orgRule('registry.sources.write', 'POST /registry-sources/{id}/sync', {
    method: 'POST',
    url: `/registry-sources/${SRC}/sync`,
    body: {},
  }),
  orgRule('registry.sources.write', 'PUT /registry-sources/{id}/policy', {
    method: 'PUT',
    url: `/registry-sources/${SRC}/policy`,
    body: { mode: 'request' },
  }),
  // registry.install
  orgRule('registry.install', 'GET /registry/servers', { method: 'GET', url: '/registry/servers' }),
  orgRule('registry.install', 'GET /registry/servers/{sourceId}/{name}/{version}', {
    method: 'GET',
    url: `/registry/servers/${SRC}/${NAME}/1.0.0`,
  }),
  orgRule('registry.install', 'POST /registry/install', {
    method: 'POST',
    url: '/registry/install',
    body: { sourceId: SRC, name: 'io.github.acme/remote-docs', version: '1.0.0' },
  }),
  orgRule('registry.install', 'GET /install-requests', { method: 'GET', url: '/install-requests' }),
  orgRule('registry.install', 'POST /install-requests', {
    method: 'POST',
    url: '/install-requests',
    body: {
      sourceId: SRC,
      name: 'io.github.acme/remote-docs',
      version: '1.0.0',
      justification: 'authz',
    },
  }),
  // registry.requests.decide: the request of member A (team A)
  orgRule('registry.requests.decide', 'POST /install-requests/{id}/approve', {
    method: 'POST',
    url: '/install-requests/req-1/approve',
  }),
  orgRule('registry.requests.decide', 'POST /install-requests/{id}/reject', {
    method: 'POST',
    url: '/install-requests/req-1/reject',
    body: { reason: 'no' },
  }),
  // policies.write
  orgRule('policies.write', 'POST /policy-rules', {
    method: 'POST',
    url: '/policy-rules',
    body: { name: 'r', effect: 'forbid', who: {}, what: {} },
  }),
  orgRule('policies.write', 'PATCH /policy-rules/{id}', {
    method: 'PATCH',
    url: '/policy-rules/rule-1',
    body: { enabled: false },
  }),
  orgRule('policies.write', 'DELETE /policy-rules/{id}', {
    method: 'DELETE',
    url: '/policy-rules/rule-1',
  }),
  orgRule('policies.write', 'POST /custom-policies', {
    method: 'POST',
    url: '/custom-policies',
    body: { name: 'c', cedar: 'x', tests: [] },
  }),
  orgRule('policies.write', 'PATCH /custom-policies/{id}', {
    method: 'PATCH',
    url: '/custom-policies/cp-1',
    body: { enabled: false },
  }),
  orgRule('policies.write', 'DELETE /custom-policies/{id}', {
    method: 'DELETE',
    url: '/custom-policies/cp-1',
  }),
  orgRule('policies.write', 'POST /policies/validate', {
    method: 'POST',
    url: '/policies/validate',
    body: { cedar: 'x' },
  }),
  orgRule('policies.write', 'POST /policies/simulate', {
    method: 'POST',
    url: '/policies/simulate',
    body: {},
  }),
  // guards.write
  orgRule('guards.write', 'POST /guard-profiles', {
    method: 'POST',
    url: '/guard-profiles',
    body: { name: 'g', guards: [] },
  }),
  orgRule('guards.write', 'PATCH /guard-profiles/{id}', {
    method: 'PATCH',
    url: '/guard-profiles/gp-1',
    body: { latencyBudgetMs: 900 },
  }),
  orgRule('guards.write', 'DELETE /guard-profiles/{id}', {
    method: 'DELETE',
    url: '/guard-profiles/gp-1',
  }),
  orgRule('guards.write', 'POST /guard-profiles/{id}/test', {
    method: 'POST',
    url: '/guard-profiles/gp-1/test',
    body: { text: 'hi' },
  }),
  orgRule('guards.write', 'PUT /settings/model-guards', {
    method: 'PUT',
    url: '/settings/model-guards',
    body: { jev: null, llmJudge: null, classifier: null },
  }),
  // limits.write
  orgRule('limits.write', 'POST /limit-rules', {
    method: 'POST',
    url: '/limit-rules',
    body: {
      name: 'l',
      subject: 'user',
      kind: 'rate',
      params: { points: 1, perSeconds: 1, burst: 0 },
    },
  }),
  orgRule('limits.write', 'PATCH /limit-rules/{id}', {
    method: 'PATCH',
    url: '/limit-rules/lr-1',
    body: { enabled: false },
  }),
  orgRule('limits.write', 'DELETE /limit-rules/{id}', {
    method: 'DELETE',
    url: '/limit-rules/lr-1',
  }),
  // org.view
  ...[
    '/registry-sources',
    `/registry-sources/${SRC}/policy`,
    '/policy-rules',
    '/custom-policies',
    '/guard-profiles',
    '/guard-profiles/gp-1',
    '/settings/model-guards',
    '/limit-rules',
    '/limit-rules/lr-1/usage',
  ].map((url) =>
    orgRule(
      'org.view',
      `GET ${url.replace('src-official', '{id}').replace(/\/(gp|lr)-1/, '/{id}')}`,
      { method: 'GET', url },
    ),
  ),
  // secrets.org
  orgRule('secrets.org', 'GET /secrets', {
    method: 'GET',
    url: '/secrets',
    query: { scope: 'org' },
  }),
  orgRule('secrets.org', 'PUT /secrets/org/{ownerId}/{name}', {
    method: 'PUT',
    url: '/secrets/org/org/K',
    body: SECRET_BODY,
  }),
  orgRule('secrets.org', 'DELETE /secrets/org/{ownerId}/{name}', {
    method: 'DELETE',
    url: '/secrets/org/org/K',
  }),
  // secrets.team
  {
    rule: 'secrets.team',
    route: 'GET /secrets',
    request: (scope, actor) => ({
      method: 'GET',
      url: '/secrets',
      query: { scope: 'team', ownerId: teamOwner(scope, actor) },
    }),
  },
  {
    rule: 'secrets.team',
    route: 'PUT /secrets/team/{ownerId}/{name}',
    request: (scope, actor) => ({
      method: 'PUT',
      url: `/secrets/team/${teamOwner(scope, actor)}/K`,
      body: SECRET_BODY,
    }),
  },
  {
    rule: 'secrets.team',
    route: 'DELETE /secrets/team/{ownerId}/{name}',
    request: (scope, actor) => ({
      method: 'DELETE',
      url: `/secrets/team/${teamOwner(scope, actor)}/K`,
    }),
  },
  // secrets.user
  {
    rule: 'secrets.user',
    route: 'GET /secrets',
    request: (scope, actor) => ({
      method: 'GET',
      url: '/secrets',
      query: { scope: 'user', ownerId: userOwner(scope, actor) },
    }),
  },
  {
    rule: 'secrets.user',
    route: 'PUT /secrets/user/{ownerId}/{name}',
    request: (scope, actor) => ({
      method: 'PUT',
      url: `/secrets/user/${userOwner(scope, actor)}/K`,
      body: SECRET_BODY,
    }),
  },
  {
    rule: 'secrets.user',
    route: 'DELETE /secrets/user/{ownerId}/{name}',
    request: (scope, actor) => ({
      method: 'DELETE',
      url: `/secrets/user/${userOwner(scope, actor)}/K`,
    }),
  },
];

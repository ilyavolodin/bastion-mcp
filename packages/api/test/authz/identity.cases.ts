import type { ActorName } from '../helpers/world';
import { W } from '../helpers/world';
import type { AuthzCase, Req } from './types';

/**
 * The team whose resource the request targets: `own` is team A (the team of `managerOwn`, `member` and
 * `service`); `other` is team A for the manager of team B and team B for everyone else.
 */
const teamFor = (scope: 'own' | 'other', actor: ActorName): string =>
  scope === 'own' || actor === 'managerOther' ? W.teamA : W.teamB;

const accountFor = (scope: 'own' | 'other', actor: ActorName): string =>
  teamFor(scope, actor) === W.teamA ? W.svc : 'svc-b';

const marketFor = (scope: 'own' | 'other', actor: ActorName): string =>
  teamFor(scope, actor) === W.teamA ? 'mkt-team-a' : 'mkt-team-b';

const userFor = (scope: 'own' | 'other', actor: ActorName): string =>
  scope === 'own' || actor === 'managerOther' ? W.memberA : W.memberB;

const callFor = (scope: 'own' | 'other', actor: ActorName): string =>
  userFor(scope, actor) === W.memberA ? 'call-1' : 'call-2';

const get = (url: string, query?: Record<string, string>): Req => ({
  method: 'GET',
  url,
  ...(query ? { query } : {}),
});

const sa = (route: string, request: AuthzCase['request']): AuthzCase => ({
  rule: 'service-accounts.write',
  route,
  request,
});

/** Cases for service accounts, identity providers, OAuth clients, marketplaces, observability, audit and settings. */
export const identityCases: AuthzCase[] = [
  // --- service accounts: the account's team decides (10.1) ----------------------------------------------
  sa('POST /service-accounts', (scope, actor) => ({
    method: 'POST',
    url: '/service-accounts',
    body: { teamId: teamFor(scope, actor), slug: 'authz-bot', displayName: 'Bot' },
  })),
  sa('PATCH /service-accounts/{id}', (scope, actor) => ({
    method: 'PATCH',
    url: `/service-accounts/${accountFor(scope, actor)}`,
    body: { displayName: 'Renamed' },
  })),
  sa('DELETE /service-accounts/{id}', (scope, actor) => ({
    method: 'DELETE',
    url: `/service-accounts/${accountFor(scope, actor)}`,
  })),
  sa('POST /service-accounts/{id}/credentials', (scope, actor) => ({
    method: 'POST',
    url: `/service-accounts/${accountFor(scope, actor)}/credentials`,
    body: {},
  })),
  ...(
    [
      '/service-accounts',
      '/idp-connections',
      '/scim-tokens',
      '/oauth-clients',
      '/settings',
      '/system/status',
      '/idp-connections/{id}',
    ] as const
  ).map(
    (path): AuthzCase => ({
      rule: 'org.view',
      route: `GET ${path}`,
      request: () => get(path.replace('{id}', 'idp-1')),
    }),
  ),

  // --- identity providers and SCIM -----------------------------------------------------------------------
  ...(
    [
      [
        'POST /idp-connections',
        'POST',
        '/idp-connections',
        {
          name: 'Okta',
          issuer: 'https://idp.example.com',
          discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
          clientId: 'c',
          clientSecret: 's',
        },
      ],
      ['PATCH /idp-connections/{id}', 'PATCH', '/idp-connections/idp-1', { enabled: false }],
      ['DELETE /idp-connections/{id}', 'DELETE', '/idp-connections/idp-1', undefined],
      ['POST /idp-connections/{id}/test', 'POST', '/idp-connections/idp-1/test', undefined],
      ['POST /scim-tokens', 'POST', '/scim-tokens', { name: 'scim' }],
      ['DELETE /scim-tokens/{id}', 'DELETE', '/scim-tokens/scim-1', undefined],
    ] as const
  ).map(
    ([route, method, url, body]): AuthzCase => ({
      rule: 'idp.write',
      route,
      request: () => ({ method, url, ...(body === undefined ? {} : { body }) }),
    }),
  ),

  // --- OAuth clients ---------------------------------------------------------------------------------------
  {
    rule: 'oauth-clients.write',
    route: 'POST /oauth-clients',
    request: () => ({
      method: 'POST',
      url: '/oauth-clients',
      body: { clientId: 'https://c.example.com' },
    }),
  },
  {
    rule: 'oauth-clients.write',
    route: 'PATCH /oauth-clients/{id}',
    request: () => ({ method: 'PATCH', url: '/oauth-clients/client-1', body: { blocked: true } }),
  },

  // --- marketplaces: reads follow the audience; writes follow the owner ------------------------------------
  {
    rule: 'catalog.read',
    route: 'GET /marketplaces',
    scopedDeny: 200,
    request: () => get('/marketplaces'),
  },
  ...(['', '/releases', '/mirror', '/usage'] as const).map(
    (suffix): AuthzCase => ({
      rule: 'catalog.read',
      route: `GET /marketplaces/{id}${suffix}`,
      request: (scope, actor) => get(`/marketplaces/${marketFor(scope, actor)}${suffix}`),
    }),
  ),
  {
    rule: 'catalog.read',
    route: 'GET /marketplaces/{id}/rollout',
    request: (scope, actor) =>
      get(`/marketplaces/${marketFor(scope, actor)}/rollout`, { client: 'claude-code' }),
  },
  ...(
    [
      ['POST /marketplaces', 'POST', () => '/marketplaces'],
      ['PATCH /marketplaces/{id}', 'PATCH', (m: string) => `/marketplaces/${m}`],
      ['DELETE /marketplaces/{id}', 'DELETE', (m: string) => `/marketplaces/${m}`],
      [
        'PUT /marketplaces/{id}/items/{entryId}',
        'PUT',
        (m: string) => `/marketplaces/${m}/items/entry-mkt-1`,
      ],
      [
        'DELETE /marketplaces/{id}/items/{entryId}',
        'DELETE',
        (m: string) => `/marketplaces/${m}/items/entry-mkt-1`,
      ],
      [
        'POST /marketplaces/{id}/releases/{n}/promote',
        'POST',
        (m: string) => `/marketplaces/${m}/releases/1/promote`,
      ],
      ['PUT /marketplaces/{id}/mirror', 'PUT', (m: string) => `/marketplaces/${m}/mirror`],
      [
        'POST /marketplaces/{id}/mirror/push',
        'POST',
        (m: string) => `/marketplaces/${m}/mirror/push`,
      ],
    ] as const
  ).flatMap(([route, method, path]): AuthzCase[] => {
    const body = (team: string | null) =>
      route === 'POST /marketplaces'
        ? {
            slug: `authz-${team ?? 'org'}`,
            displayName: 'X',
            ...(team ? { ownerTeamId: team } : {}),
          }
        : route === 'PATCH /marketplaces/{id}'
          ? { displayName: 'X' }
          : route === 'PUT /marketplaces/{id}/mirror'
            ? { provider: 'github', repo: 'a/b', credentialSecretId: 's' }
            : {};
    return [
      {
        rule: 'marketplaces.write.team',
        route,
        request: (scope, actor) => ({
          method,
          url: path(marketFor(scope, actor)),
          body: body(teamFor(scope, actor)),
        }),
      },
      {
        rule: 'marketplaces.write.org',
        route,
        request: () => ({ method, url: path('mkt-org'), body: body(null) }),
      },
    ];
  }),

  // --- observability ---------------------------------------------------------------------------------------
  {
    rule: 'logs.org',
    route: 'GET /calls',
    request: () => get('/calls'),
  },
  {
    rule: 'logs.team',
    route: 'GET /calls',
    request: (scope, actor) => get('/calls', { team: teamFor(scope, actor) }),
  },
  {
    rule: 'logs.user',
    route: 'GET /calls',
    request: (scope, actor) => get('/calls', { user: userFor(scope, actor) }),
  },
  {
    // A call with no owner is org-wide data: only the org rule applies (15.5).
    rule: 'logs.org',
    route: 'GET /calls/{id}',
    request: () => get('/calls/call-anon'),
  },
  {
    rule: 'logs.user',
    route: 'GET /calls/{id}',
    request: (scope, actor) => get(`/calls/${callFor(scope, actor)}`),
  },
  ...(['/stats/latency', '/stats/guards', '/stats/sandboxes', '/security/findings'] as const).map(
    (path): AuthzCase => ({ rule: 'logs.org', route: `GET ${path}`, request: () => get(path) }),
  ),
  { rule: 'logs.org', route: 'GET /stats/calls', request: () => get('/stats/calls') },
  {
    rule: 'logs.team',
    route: 'GET /stats/calls',
    request: (scope, actor) => get('/stats/calls', { team: teamFor(scope, actor) }),
  },
  {
    rule: 'logs.user',
    route: 'GET /stats/calls',
    request: (scope, actor) => get('/stats/calls', { user: userFor(scope, actor) }),
  },
  {
    // Everybody at once (the busiest people) is org-wide data.
    rule: 'logs.org',
    route: 'GET /stats/calls',
    request: () => get('/stats/calls', { groupBy: 'user' }),
  },

  // --- audit -----------------------------------------------------------------------------------------------
  { rule: 'audit.org', route: 'GET /audit', request: () => get('/audit') },
  {
    rule: 'audit.team',
    route: 'GET /audit',
    request: (scope, actor) => get('/audit', { team: teamFor(scope, actor) }),
  },
  { rule: 'audit.org', route: 'GET /audit/export', request: () => get('/audit/export') },
  { rule: 'audit.org', route: 'GET /audit/verify', request: () => get('/audit/verify') },

  // --- settings and system -----------------------------------------------------------------------------------
  {
    rule: 'settings.write',
    route: 'PATCH /settings',
    request: () => ({ method: 'PATCH', url: '/settings', body: { personalInstalls: 'off' } }),
  },
  {
    rule: 'settings.write',
    route: 'POST /system/kms/rotate',
    request: () => ({ method: 'POST', url: '/system/kms/rotate' }),
  },
  {
    rule: 'settings.write',
    route: 'POST /system/signing-keys/rotate',
    request: () => ({ method: 'POST', url: '/system/signing-keys/rotate' }),
  },
];

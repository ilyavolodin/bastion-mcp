import type { ActorName } from '../helpers/world';
import type { AuthzCase, Req } from './types';

/** The installation in the actor's scope (`own`) or outside it (`other`). */
const inst = (scope: 'own' | 'other', actor: ActorName): string => {
  if (actor === 'member') return scope === 'own' ? 'inst-member-a' : 'inst-member-b';
  if (actor === 'service') return 'inst-svc-a';
  return 'inst-team-a';
};

const forInstallation = (
  route: string,
  rule: string,
  build: (id: string) => Omit<Req, 'method' | 'url'> & { path: string },
): AuthzCase => {
  const method = route.split(' ')[0] as Req['method'];
  return {
    rule,
    route,
    request: (scope, actor) => {
      const { path, ...rest } = build(inst(scope, actor));
      return { method, url: path, ...rest };
    },
  };
};

const MANAGE_ROUTES: Array<
  [string, (id: string) => Omit<Req, 'method' | 'url'> & { path: string }]
> = [
  ['GET /installations/{id}', (id) => ({ path: `/installations/${id}` })],
  [
    'PATCH /installations/{id}',
    (id) => ({ path: `/installations/${id}`, body: { displayName: 'x' } }),
  ],
  ['DELETE /installations/{id}', (id) => ({ path: `/installations/${id}` })],
  ['POST /installations/{id}/restart', (id) => ({ path: `/installations/${id}/restart` })],
  ['GET /installations/{id}/tools', (id) => ({ path: `/installations/${id}/tools` })],
  ['GET /installations/{id}/prompts', (id) => ({ path: `/installations/${id}/prompts` })],
  ['GET /installations/{id}/resources', (id) => ({ path: `/installations/${id}/resources` })],
  ['GET /installations/{id}/templates', (id) => ({ path: `/installations/${id}/templates` })],
  [
    'POST /installations/{id}/try',
    (id) => ({ path: `/installations/${id}/try`, body: { kind: 'tool', name: 'search' } }),
  ],
  [
    'GET /installations/{id}/logs',
    (id) => ({ path: `/installations/${id}/logs`, query: { follow: 'false' } }),
  ],
  ['GET /installations/{id}/egress', (id) => ({ path: `/installations/${id}/egress` })],
  [
    'POST /installations/{id}/connect',
    (id) => ({ path: `/installations/${id}/connect`, body: {} }),
  ],
  ['DELETE /installations/{id}/connection', (id) => ({ path: `/installations/${id}/connection` })],
  [
    'PUT /installations/{id}/secrets/{name}',
    (id) => ({ path: `/installations/${id}/secrets/TOKEN`, body: { value: 'v' } }),
  ],
];

const personal = (
  route: string,
  build: Omit<Req, 'method' | 'url'> & { path: string },
): AuthzCase => {
  const method = route.split(' ')[0] as Req['method'];
  const { path, ...rest } = build;
  return { rule: 'installations.personal', route, request: () => ({ method, url: path, ...rest }) };
};

const MY_ENDPOINT = 'ep-member-a';

export const installationsCases: AuthzCase[] = [
  personal('GET /installations', { path: '/installations' }),
  personal('GET /endpoints', { path: '/endpoints' }),
  personal('POST /endpoints', { path: '/endpoints', body: { slug: 'authz-ep', displayName: 'E' } }),
  personal('GET /endpoints/{id}', { path: `/endpoints/${MY_ENDPOINT}` }),
  personal('PATCH /endpoints/{id}', {
    path: `/endpoints/${MY_ENDPOINT}`,
    body: { displayName: 'x' },
  }),
  personal('DELETE /endpoints/{id}', { path: `/endpoints/${MY_ENDPOINT}` }),
  personal('GET /endpoints/{id}/client-config', {
    path: `/endpoints/${MY_ENDPOINT}/client-config`,
    query: { client: 'cursor' },
  }),
  personal('POST /overrides/preview', {
    path: '/overrides/preview',
    body: { doc: { version: 1 }, upstream: {} },
  }),
  personal('POST /installations', {
    path: '/installations',
    body: {
      personalSpec: {
        type: 'remote',
        transport: 'streamable-http',
        url: 'https://x.example.com/mcp',
        auth: { mode: 'none' },
      },
      slug: 'authz-personal',
    },
  }),
  {
    rule: 'installations.from-entry',
    route: 'POST /installations',
    request: (scope, actor) => ({
      method: 'POST',
      url: '/installations',
      body: {
        catalogEntryId:
          scope === 'own'
            ? 'entry-org'
            : actor === 'managerOther'
              ? 'entry-team-a'
              : 'entry-team-b',
        slug: 'authz-from-entry',
      },
    }),
  },
  {
    rule: 'installations.team',
    route: 'POST /installations',
    request: (scope, actor) => ({
      method: 'POST',
      url: '/installations',
      body: {
        catalogEntryId: 'entry-team-a',
        ownerType: 'team',
        teamId: scope === 'own' || actor === 'managerOther' ? 'team-a' : 'team-b',
        slug: 'authz-team',
      },
    }),
  },
  ...MANAGE_ROUTES.map(([route, build]) => forInstallation(route, 'installations.manage', build)),
  forInstallation('GET /installations/{id}/overrides', 'overrides.installation', (id) => ({
    path: `/installations/${id}/overrides`,
  })),
  forInstallation('PUT /installations/{id}/overrides', 'overrides.installation', (id) => ({
    path: `/installations/${id}/overrides`,
    body: { version: 1 },
  })),
  {
    rule: 'overrides.catalog',
    route: 'GET /catalog/{id}/versions/{vid}/overrides',
    request: () => ({
      method: 'GET',
      url: '/catalog/entry-team-a/versions/ver-team-a-draft/overrides',
    }),
  },
  {
    rule: 'overrides.catalog',
    route: 'PUT /catalog/{id}/versions/{vid}/overrides',
    request: () => ({
      method: 'PUT',
      url: '/catalog/entry-team-a/versions/ver-team-a-draft/overrides',
      body: { version: 1 },
    }),
  },
  {
    rule: 'org.view',
    route: 'GET /drift-reviews',
    request: () => ({ method: 'GET', url: '/drift-reviews' }),
  },
  {
    rule: 'drift.write',
    route: 'POST /drift-reviews/{id}/approve',
    request: () => ({ method: 'POST', url: '/drift-reviews/drift-1/approve', body: {} }),
  },
  {
    rule: 'drift.write',
    route: 'POST /drift-reviews/{id}/reject',
    request: () => ({
      method: 'POST',
      url: '/drift-reviews/drift-1/reject',
      body: { reason: 'no' },
    }),
  },
  {
    rule: 'org.view',
    route: 'GET /auto-install-policies',
    request: () => ({ method: 'GET', url: '/auto-install-policies' }),
  },
  ...(['auto-install.team', 'auto-install.org'] as const).flatMap((rule): AuthzCase[] => {
    const id = rule === 'auto-install.team' ? 'aip-team-a' : 'aip-org';
    return [
      {
        rule,
        route: 'POST /auto-install-policies',
        request: () => ({
          method: 'POST',
          url: '/auto-install-policies',
          body: {
            catalogEntryId: 'entry-i-pub',
            target: rule === 'auto-install.team' ? { teamIds: ['team-a'] } : { all: true },
          },
        }),
      },
      {
        rule,
        route: 'PATCH /auto-install-policies/{id}',
        request: () => ({
          method: 'PATCH',
          url: `/auto-install-policies/${id}`,
          body: { enabled: false },
        }),
      },
      {
        rule,
        route: 'DELETE /auto-install-policies/{id}',
        request: () => ({ method: 'DELETE', url: `/auto-install-policies/${id}` }),
      },
      {
        rule,
        route: 'POST /auto-install-policies/{id}/preview',
        request: () => ({ method: 'POST', url: `/auto-install-policies/${id}/preview`, body: {} }),
      },
    ];
  }),
];

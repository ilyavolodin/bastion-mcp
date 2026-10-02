import type { ActorName } from '../helpers/world';
import type { AuthzCase, Req } from './types';

/** Entry the caller is in scope of (`own`: team A's) or not (`other`: team B's; team A's for B's manager). */
const entryFor = (scope: 'own' | 'other', actor: ActorName): { entry: string; ver: string } =>
  scope === 'own' || actor === 'managerOther'
    ? { entry: 'entry-team-a', ver: 'ver-team-a' }
    : { entry: 'entry-team-b', ver: 'ver-team-b-draft' };

const teamFor = (scope: 'own' | 'other', actor: ActorName): string =>
  scope === 'own' || actor === 'managerOther' ? 'team-a' : 'team-b';

const entryCase = (
  rule: string,
  route: string,
  build: (e: { entry: string; ver: string }) => Req,
  scopedDeny?: number,
): AuthzCase => ({
  rule,
  route,
  ...(scopedDeny === undefined ? {} : { scopedDeny }),
  request: (scope, actor) => build(entryFor(scope, actor)),
});

const fixed = (rule: string, route: string, req: Req): AuthzCase => ({
  rule,
  route,
  request: () => req,
});

const pluginUrl = '/catalog/entry-plugin/versions/ver-plugin';
const b64 = Buffer.from('x').toString('base64');
const newEntry = (team: string | null) => ({
  slug: 'authz-new',
  displayName: 'New',
  ...(team ? { ownerTeamId: team } : {}),
});
const importBody = (team: string | null) => ({
  ...(team ? { ownerTeamId: team } : {}),
  source: { kind: 'git', url: 'https://git.example.com/p.git' },
});

export const catalogCases: AuthzCase[] = [
  // --- catalog.read ------------------------------------------------------------------------------------
  {
    rule: 'catalog.read',
    route: 'GET /catalog',
    scopedDeny: 200,
    request: () => ({ method: 'GET', url: '/catalog' }),
  },
  entryCase('catalog.read', 'GET /catalog/{id}', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}`,
  })),
  entryCase('catalog.read', 'GET /catalog/{id}/versions', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}/versions`,
  })),
  entryCase('catalog.read', 'GET /catalog/{id}/versions/{vid}', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}/versions/${e.ver}`,
  })),
  entryCase('catalog.read', 'GET /catalog/{id}/versions/{vid}/test', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}/versions/${e.ver}/test`,
  })),
  entryCase('catalog.read', 'GET /catalog/{id}/versions/{vid}/files', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}/versions/${e.ver}/files`,
  })),
  entryCase('catalog.read', 'GET /catalog/{id}/versions/{vid}/files/{path}', (e) => ({
    method: 'GET',
    url: `/catalog/${e.entry}/versions/${e.ver}/files/SKILL.md`,
  })),
  {
    rule: 'catalog.read',
    route: 'GET /store',
    scopedDeny: 200,
    request: () => ({ method: 'GET', url: '/store' }),
  },
  {
    rule: 'catalog.read',
    route: 'GET /store/{slug}',
    scopedDeny: 404,
    request: (scope, actor) => ({
      method: 'GET',
      url: `/store/${scope === 'own' || actor === 'managerOther' ? 'team-a-server' : 'team-b-server'}`,
    }),
  },

  // --- catalog.create.* --------------------------------------------------------------------------------
  {
    rule: 'catalog.create.team',
    route: 'POST /catalog',
    request: (scope, actor) => ({
      method: 'POST',
      url: '/catalog',
      body: newEntry(teamFor(scope, actor)),
    }),
  },
  {
    rule: 'catalog.create.team',
    route: 'POST /catalog/import',
    request: (scope, actor) => ({
      method: 'POST',
      url: '/catalog/import',
      body: importBody(teamFor(scope, actor)),
    }),
  },
  fixed('catalog.create.org', 'POST /catalog', {
    method: 'POST',
    url: '/catalog',
    body: newEntry(null),
  }),
  fixed('catalog.create.org', 'POST /catalog/import', {
    method: 'POST',
    url: '/catalog/import',
    body: importBody(null),
  }),

  // --- catalog.update / delete -------------------------------------------------------------------------------
  entryCase('catalog.update', 'PATCH /catalog/{id}', (e) => ({
    method: 'PATCH',
    url: `/catalog/${e.entry}`,
    body: { description: 'changed' },
  })),
  entryCase('catalog.update', 'POST /catalog/{id}/versions', (e) => ({
    method: 'POST',
    url: `/catalog/${e.entry}/versions`,
    body: { label: 'authz-label' },
  })),
  entryCase('catalog.update', 'PATCH /catalog/{id}/versions/{vid}', (e) => ({
    method: 'PATCH',
    url: `/catalog/${e.entry}/versions/${e.ver}`,
    body: { changelog: 'authz' },
  })),
  entryCase('catalog.update', 'POST /catalog/{id}/versions/{vid}/test', (e) => ({
    method: 'POST',
    url: `/catalog/${e.entry}/versions/${e.ver}/test`,
  })),
  entryCase('catalog.update', 'PUT /catalog/{id}/versions/{vid}/files/{path}', (e) => ({
    method: 'PUT',
    url: `/catalog/${e.entry}/versions/${e.ver}/files/a.md`,
    body: { contentBase64: b64 },
  })),
  entryCase('catalog.update', 'DELETE /catalog/{id}/versions/{vid}/files/{path}', (e) => ({
    method: 'DELETE',
    url: `/catalog/${e.entry}/versions/${e.ver}/files/a.md`,
  })),
  entryCase('catalog.delete', 'DELETE /catalog/{id}', (e) => ({
    method: 'DELETE',
    url: `/catalog/${e.entry}`,
  })),

  // --- publish ---------------------------------------------------------------------------------------------
  entryCase('catalog.publish.team', 'POST /catalog/{id}/versions/{vid}/publish', (e) => ({
    method: 'POST',
    url: `/catalog/${e.entry}/versions/${e.ver}/publish`,
  })),
  entryCase('catalog.publish.org', 'POST /catalog/{id}/versions/{vid}/publish', (e) => ({
    method: 'POST',
    url: `/catalog/${e.entry}/versions/${e.ver}/publish`,
    body: { visibility: { org: true } },
  })),

  // --- plugins -------------------------------------------------------------------------------------------------
  fixed('plugin.approve-executable', 'POST /catalog/{id}/versions/{vid}/approve-executable', {
    method: 'POST',
    url: `${pluginUrl}/approve-executable`,
  }),
  fixed('org.view', 'GET /plugin-sources', { method: 'GET', url: '/plugin-sources' }),
  fixed('plugin-sources.write', 'POST /plugin-sources', {
    method: 'POST',
    url: '/plugin-sources',
    body: { name: 'x', gitUrl: 'https://git.example.com/x.git' },
  }),
  fixed('plugin-sources.write', 'PATCH /plugin-sources/{id}', {
    method: 'PATCH',
    url: '/plugin-sources/psrc-1',
    body: { ref: 'dev' },
  }),
  fixed('plugin-sources.write', 'DELETE /plugin-sources/{id}', {
    method: 'DELETE',
    url: '/plugin-sources/psrc-1',
  }),
  fixed('plugin-sources.write', 'POST /plugin-sources/{id}/sync', {
    method: 'POST',
    url: '/plugin-sources/psrc-1/sync',
  }),
];

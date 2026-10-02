import { W } from '../helpers/world';
import type { AuthzCase } from './types';

const memberOf = (actor: string): string => (actor === 'member' ? W.memberA : W.memberB);

/** Cases for the self, users and teams areas (17.2). */
export const usersCases: AuthzCase[] = [
  // --- self: any authenticated principal --------------------------------------------------------------
  { rule: 'self', route: 'GET /me', request: () => ({ method: 'GET', url: '/me' }) },
  {
    rule: 'self',
    route: 'PATCH /me',
    request: () => ({ method: 'PATCH', url: '/me', body: { displayName: 'Me' } }),
  },
  {
    rule: 'self',
    route: 'POST /me/password',
    request: () => ({
      method: 'POST',
      url: '/me/password',
      body: { currentPassword: 'old password 1', newPassword: 'a much better passphrase' },
    }),
  },
  {
    rule: 'self',
    route: 'GET /me/notifications',
    request: () => ({ method: 'GET', url: '/me/notifications' }),
  },
  {
    rule: 'self',
    route: 'POST /me/notifications/{id}/read',
    request: () => ({ method: 'POST', url: '/me/notifications/nope/read' }),
  },
  { rule: 'self', route: 'GET /me/quotas', request: () => ({ method: 'GET', url: '/me/quotas' }) },
  {
    rule: 'self',
    route: 'GET /me/oauth-grants',
    request: () => ({ method: 'GET', url: '/me/oauth-grants' }),
  },
  {
    rule: 'self',
    route: 'DELETE /me/oauth-grants/{id}',
    request: () => ({ method: 'DELETE', url: '/me/oauth-grants/nope' }),
  },
  { rule: 'self', route: 'GET /tokens', request: () => ({ method: 'GET', url: '/tokens' }) },
  {
    rule: 'self',
    route: 'POST /tokens',
    request: () => ({
      method: 'POST',
      url: '/tokens',
      body: { name: 'ci', scopes: ['api:read'] },
    }),
  },
  {
    rule: 'self',
    route: 'DELETE /tokens/{id}',
    request: () => ({ method: 'DELETE', url: '/tokens/nope' }),
  },

  // --- read-only views of org configuration -----------------------------------------------------------
  { rule: 'org.view', route: 'GET /users', request: () => ({ method: 'GET', url: '/users' }) },
  {
    rule: 'org.view',
    route: 'GET /users/{id}',
    request: () => ({ method: 'GET', url: `/users/${W.memberA}` }),
  },
  { rule: 'org.view', route: 'GET /teams', request: () => ({ method: 'GET', url: '/teams' }) },
  {
    rule: 'org.view',
    route: 'GET /role-mapping-rules',
    request: () => ({ method: 'GET', url: '/role-mapping-rules' }),
  },
  {
    rule: 'team.view',
    route: 'GET /teams/{id}',
    request: () => ({ method: 'GET', url: `/teams/${W.teamA}` }),
  },

  // --- writes ---------------------------------------------------------------------------------------------
  {
    rule: 'users.write',
    route: 'POST /users',
    request: () => ({
      method: 'POST',
      url: '/users',
      body: { email: 'new@example.com', displayName: 'New' },
    }),
  },
  {
    rule: 'users.write',
    route: 'PATCH /users/{id}',
    request: () => ({
      method: 'PATCH',
      url: `/users/${W.memberB}`,
      body: { displayName: 'Renamed' },
    }),
  },
  {
    rule: 'users.write',
    route: 'POST /users/{id}/deactivate',
    request: (_s, actor) => ({ method: 'POST', url: `/users/${memberOf(actor)}/deactivate` }),
  },
  {
    rule: 'users.write',
    route: 'POST /role-mapping-rules',
    request: () => ({
      method: 'POST',
      url: '/role-mapping-rules',
      body: { groupPattern: 'eng-.*', mapsTo: { orgRole: 'member' } },
    }),
  },
  {
    rule: 'users.write',
    route: 'PATCH /role-mapping-rules/{id}',
    request: () => ({
      method: 'PATCH',
      url: '/role-mapping-rules/nope',
      body: { priority: 5 },
    }),
  },
  {
    rule: 'users.write',
    route: 'DELETE /role-mapping-rules/{id}',
    request: () => ({ method: 'DELETE', url: '/role-mapping-rules/nope' }),
  },
  {
    rule: 'teams.write',
    route: 'POST /teams',
    request: () => ({
      method: 'POST',
      url: '/teams',
      body: { slug: 'team-c', displayName: 'Team C' },
    }),
  },
  {
    rule: 'teams.write',
    route: 'PATCH /teams/{id}',
    request: () => ({
      method: 'PATCH',
      url: `/teams/${W.teamB}`,
      body: { displayName: 'Renamed' },
    }),
  },
  {
    rule: 'teams.write',
    route: 'DELETE /teams/{id}',
    request: () => ({ method: 'DELETE', url: `/teams/${W.teamB}` }),
  },
  {
    rule: 'teams.members',
    route: 'PUT /teams/{id}/members/{userId}',
    request: () => ({
      method: 'PUT',
      url: `/teams/${W.teamA}/members/${W.memberB}`,
      body: { role: 'member' },
    }),
  },
  {
    rule: 'teams.members',
    route: 'DELETE /teams/{id}/members/{userId}',
    request: () => ({ method: 'DELETE', url: `/teams/${W.teamA}/members/${W.memberB}` }),
  },
];

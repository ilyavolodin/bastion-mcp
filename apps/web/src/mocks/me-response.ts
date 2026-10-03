import type { MeResponse } from '@/api/me';
import type { Me } from '@/api/views/session';
import { PLATFORM_TEAM_ID, PLATFORM_TEAM_SLUG } from './seed';
import { getDb } from './state';

/** The slug of a team the person belongs to: the team row's, so a renamed team keeps its slug. */
const slugOf = (id: string): string =>
  getDb().data.access.teams.find((t) => t.id === id)?.slug ??
  (id === PLATFORM_TEAM_ID ? PLATFORM_TEAM_SLUG : id);

/** The mock's `GET /me` body. Typed by the generated response, so API drift is a compile error. */
export const toMeResponse = (me: Me, updatedAt: string): MeResponse => ({
  id: me.id,
  type: 'user',
  orgRole: me.orgRole,
  authMethod: 'session',
  scopes: ['api:read', 'api:write'],
  email: me.email,
  displayName: me.name,
  status: 'active',
  teams: me.teams.map((t) => ({
    teamId: t.id,
    role: t.role,
    slug: slugOf(t.id),
    displayName: t.name,
  })),
  org: me.org,
  capabilities: me.capabilities,
  updatedAt,
});

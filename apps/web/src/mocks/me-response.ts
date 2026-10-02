import type { MeResponse } from '@/api/me';
import type { Me } from '@/api/types';

/** The mock's `GET /me` body. Typed by the generated response, so API drift is a compile error. */
export const toMeResponse = (me: Me): MeResponse => ({
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
    slug: t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    displayName: t.name,
  })),
  org: me.org,
  capabilities: me.capabilities,
  updatedAt: '2026-10-01T00:00:00.000Z',
});

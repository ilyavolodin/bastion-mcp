import type { ApiPaths } from '@bastion-mcp/api-client';
import { cachedTheme } from '@/lib/theme';
import type { Me, OrgRole, TeamRole } from './types';

/** `GET /me` exactly as the OpenAPI document describes it. */
export type MeResponse = ApiPaths['/me']['get']['responses'][200]['content']['application/json'];

const ORG_ROLE_VALUES: readonly string[] = ['admin', 'auditor', 'member'];

/** The UI view of the caller. The theme is a per-browser preference: `PATCH /me` only edits the name. */
export const toMe = (res: MeResponse): Me => ({
  id: res.id,
  email: res.email ?? '',
  name: res.displayName,
  orgRole: (ORG_ROLE_VALUES.includes(res.orgRole) ? res.orgRole : 'member') as OrgRole,
  teams: res.teams.map((t) => ({
    id: t.teamId,
    name: t.displayName ?? t.slug ?? t.teamId,
    role: (t.role === 'manager' ? 'manager' : 'member') as TeamRole,
  })),
  theme: cachedTheme() ?? 'light',
  org: res.org,
  capabilities: res.capabilities,
});

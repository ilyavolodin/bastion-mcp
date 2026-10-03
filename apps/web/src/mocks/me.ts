import type { Me, UiRole } from '@/api/views/session';
import {
  ME_ID,
  ORG_HOST,
  ORG_NAME,
  PLATFORM_TEAM_ID,
  PLATFORM_TEAM_NAME,
  TOOL_WARN_THRESHOLD,
} from './seed';

export const HOST = ORG_HOST;

/**
 * Two kinds of role meet here. The org role (`Me.orgRole`) is what the person is in the whole org: admin, auditor or
 * member. The team role (`Me.teams[].role`) is manager or member of one team. The UI role (`?as=`) is the persona the
 * console shows: a "manager" is an org member who manages a team (10.1), so the org role stays `member`.
 */
const ORG_ROLE_OF: Record<UiRole, Me['orgRole']> = {
  admin: 'admin',
  manager: 'member',
  member: 'member',
  auditor: 'auditor',
};
/** The role in the Platform team: the Admin and the Manager manage it, the others belong to it. */
const TEAM_ROLE_OF: Record<UiRole, Me['teams'][number]['role']> = {
  admin: 'manager',
  manager: 'manager',
  member: 'member',
  auditor: 'member',
};

/** The signed-in user of the mock for a UI role (`?as=` picks it in the dev server). */
export const buildMe = (role: UiRole): Me => ({
  id: ME_ID,
  email: 'dana.whitfield@acme.dev',
  name: 'Dana Whitfield',
  orgRole: ORG_ROLE_OF[role],
  teams: [{ id: PLATFORM_TEAM_ID, name: PLATFORM_TEAM_NAME, role: TEAM_ROLE_OF[role] }],
  theme: 'light',
  org: {
    name: ORG_NAME,
    host: HOST,
    baseUrl: `https://${HOST}`,
    traceUiUrl: 'https://traces.acme.dev/trace',
    toolWarnThreshold: TOOL_WARN_THRESHOLD,
  },
  capabilities: {
    registry: role !== 'auditor',
    publishOrgWide: role === 'admin',
    personalInstalls: 'remoteOnly',
  },
});

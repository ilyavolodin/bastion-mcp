/** Role model of the UI (10.1, 18.2). Everything role-aware in the SPA reads from this module. */
import type { Me, UiRole } from '@/api/views/session';

export type NavSection =
  | 'home'
  | 'store'
  | 'servers'
  | 'activity'
  | 'plugins'
  | 'observability'
  | 'security'
  | 'catalog'
  | 'registry'
  | 'access'
  | 'settings';

export type NavGroup = 'workspace' | 'oversight' | 'manage';

export const ALL_ROLES: readonly UiRole[] = ['admin', 'manager', 'member', 'auditor'];

type SectionDef = {
  label: string;
  path: string;
  group: NavGroup;
  roles: readonly UiRole[];
  /** Under 768 px these screens stay usable read-mostly (18.1). */
  compact?: boolean;
};

export const SECTIONS: Record<NavSection, SectionDef> = {
  home: { label: 'Home', path: '/', group: 'workspace', roles: ALL_ROLES, compact: true },
  store: { label: 'Store', path: '/store', group: 'workspace', roles: ALL_ROLES, compact: true },
  servers: { label: 'My servers', path: '/servers', group: 'workspace', roles: ALL_ROLES },
  activity: {
    label: 'Activity',
    path: '/activity',
    group: 'workspace',
    roles: ALL_ROLES,
    compact: true,
  },
  plugins: { label: 'Plugins', path: '/plugins', group: 'workspace', roles: ALL_ROLES },
  observability: {
    label: 'Observability',
    path: '/observability',
    group: 'oversight',
    roles: ['admin', 'manager', 'auditor'],
  },
  security: {
    label: 'Security',
    path: '/security',
    group: 'oversight',
    roles: ['admin', 'manager', 'auditor'],
  },
  catalog: { label: 'Catalog', path: '/catalog', group: 'manage', roles: ['admin', 'manager'] },
  registry: {
    label: 'Registry',
    path: '/registry',
    group: 'manage',
    roles: ['admin', 'manager', 'member'],
  },
  access: { label: 'Access', path: '/access', group: 'manage', roles: ['admin', 'manager'] },
  settings: { label: 'Settings', path: '/settings', group: 'manage', roles: ['admin'] },
};

export const NAV_ORDER: readonly NavSection[] = [
  'home',
  'store',
  'servers',
  'activity',
  'plugins',
  'observability',
  'security',
  'catalog',
  'registry',
  'access',
  'settings',
];

export const GROUP_LABEL: Record<NavGroup, string> = {
  workspace: 'Workspace',
  oversight: 'Oversight',
  manage: 'Manage',
};

/** "Manager" is a user who manages at least one team (10.1). */
export function uiRole(me: Pick<Me, 'orgRole' | 'teams'>): UiRole {
  if (me.orgRole === 'admin') return 'admin';
  if (me.orgRole === 'auditor') return 'auditor';
  return me.teams.some((t) => t.role === 'manager') ? 'manager' : 'member';
}

export const roleLabel = (role: UiRole, me?: Pick<Me, 'teams'>): string => {
  if (role === 'manager') {
    const team = me?.teams.find((t) => t.role === 'manager');
    return team ? `Manager · ${team.name}` : 'Manager';
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
};

/** Who may open a section. The registry also depends on the registry policy (18.2). */
export function canSee(
  section: NavSection,
  role: UiRole,
  caps?: Pick<Me['capabilities'], 'registry'>,
): boolean {
  if (!SECTIONS[section].roles.includes(role)) return false;
  if (section === 'registry' && caps) return caps.registry;
  return true;
}

export function visibleSections(role: UiRole, caps?: Pick<Me['capabilities'], 'registry'>) {
  return NAV_ORDER.filter((s) => canSee(s, role, caps));
}

export const ACTIVITY_SCOPE: Record<UiRole, { nav: string; header: string }> = {
  admin: { nav: 'all', header: 'Everyone' },
  manager: { nav: 'team', header: 'Your teams' },
  member: { nav: 'own', header: 'Your calls' },
  auditor: { nav: 'all', header: 'Everyone, read-only' },
};

export const sectionForPath = (pathname: string): NavSection => {
  if (pathname === '/' || pathname === '') return 'home';
  const hit = NAV_ORDER.find((s) => s !== 'home' && pathname.startsWith(SECTIONS[s].path));
  return hit ?? 'home';
};

export type DeniedCopy = { title: string; body: string; linkLabel: string; to: string };
export const DENIED: Record<NavSection, DeniedCopy> = {
  home: { title: 'Not in this role’s navigation', body: '', linkLabel: 'Back to Home', to: '/' },
  store: {
    title: 'Not in this role’s navigation',
    body: '',
    linkLabel: 'Open the Store',
    to: '/store',
  },
  servers: { title: 'Not in this role’s navigation', body: '', linkLabel: 'Back to Home', to: '/' },
  activity: {
    title: 'Not in this role’s navigation',
    body: '',
    linkLabel: 'Back to Home',
    to: '/',
  },
  plugins: { title: 'Not in this role’s navigation', body: '', linkLabel: 'Back to Home', to: '/' },
  observability: {
    title: 'Not in this role’s navigation',
    body: 'It isn’t in your navigation. Your own calls are in Activity.',
    linkLabel: 'Open Activity',
    to: '/activity',
  },
  security: {
    title: 'Not in this role’s navigation',
    body: 'A blocked call shows its guard finding in your own Activity.',
    linkLabel: 'Open Activity',
    to: '/activity',
  },
  catalog: {
    title: 'Not in this role’s navigation',
    body: 'Published servers are in the Store.',
    linkLabel: 'Open the Store',
    to: '/store',
  },
  registry: {
    title: 'Not in this role’s navigation',
    body: 'Your registry policy does not allow browsing external registries.',
    linkLabel: 'Open the Store',
    to: '/store',
  },
  access: {
    title: 'Not in this role’s navigation',
    body: 'People and rules are managed by Managers and Admins.',
    linkLabel: 'Back to Home',
    to: '/',
  },
  settings: {
    title: 'Only Admins see Settings',
    body: 'Theme and personal tokens live in the user menu for everyone.',
    linkLabel: 'Back to Home',
    to: '/',
  },
};

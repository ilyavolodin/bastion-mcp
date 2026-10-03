/**
 * View models of the signed-in user's own data (`/me/*`). The notification row of the API carries a `type`, a
 * `title` and a free-form `data` object; the bell also needs a line of text and a place to go, which are derived
 * here from `type` and `data`. A quota row becomes a labelled bar.
 */
import { asRecord, asString } from '@/lib/json';
import type { OrgRole, Res, Schemas, TeamRole } from '../schema';

export type NotificationRow = Schemas['Notification'];
export type QuotaRow = Res<'get', '/me/quotas'>['items'][number];

export type NotificationView = NotificationRow & {
  /** One line under the title (`data.message` or `data.body`, empty when the producer sent none). */
  body: string;
  /** The screen that handles it. */
  href: string | null;
};

const text = asString;

const dataOf = (row: NotificationRow): Record<string, unknown> => asRecord(row.data);

/** Where a notification leads, from its type (18.1): requests, drift and setup have a screen of their own. */
export const notificationHref = (row: NotificationRow): string | null => {
  const data = dataOf(row);
  switch (row.type) {
    case 'install_request':
      return '/registry';
    case 'drift':
    case 'drift.review':
      return '/security';
    case 'setup':
      return text(data.installationId) ? `/servers/${text(data.installationId)}` : '/servers';
    case 'approval':
      return '/catalog';
    default:
      return null;
  }
};

export const toNotification = (row: NotificationRow): NotificationView => {
  const data = dataOf(row);
  return { ...row, body: text(data.message) || text(data.body), href: notificationHref(row) };
};

export type QuotaView = {
  id: string;
  name: string;
  used: number;
  limit: number;
  /** `left`: the bar shows what is left of a budget (rate, quota); `inUse`: it shows concurrency. */
  mode: 'left' | 'inUse';
};

export const toQuota = (row: QuotaRow): QuotaView => ({
  id: `${row.ruleId}:${row.subjectId}`,
  name: row.name,
  used: row.consumed,
  limit: row.limit,
  mode: row.kind === 'concurrency' ? 'inUse' : 'left',
});

// --- the signed-in user ---------------------------------------------------------------------------------------

/** The role the UI reasons about (10.1): "Manager" is a member who manages at least one team. */
export type UiRole = 'admin' | 'manager' | 'member' | 'auditor';
export type ThemePref = 'light' | 'dark';

export type TeamRef = { id: string; name: string; role: TeamRole };

/** The caller as the screens use it: `GET /me` with the teams named and the browser-held theme. */
export type Me = {
  id: string;
  email: string;
  name: string;
  orgRole: OrgRole;
  teams: TeamRef[];
  theme: ThemePref;
  org: Res<'get', '/me'>['org'];
  /** Cedar-derived capability flags the UI cannot infer from the role alone (10.1, 11.7). */
  capabilities: Res<'get', '/me'>['capabilities'];
};

/**
 * View models of the signed-in user's own data (`/me/*`). The notification row of the API carries a `type`, a
 * `title` and a free-form `data` object; the bell also needs a line of text and a place to go, which are derived
 * here from `type` and `data`. A quota row becomes a labelled bar.
 */
import type { Res, Schemas } from '../schema';

export type NotificationRow = Schemas['Notification'];
export type QuotaRow = Res<'get', '/me/quotas'>['items'][number];

export type NotificationView = NotificationRow & {
  /** One line under the title (`data.message` or `data.body`, empty when the producer sent none). */
  body: string;
  /** The screen that handles it. */
  href: string | null;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const dataOf = (row: NotificationRow): Record<string, unknown> =>
  typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
    ? (row.data as Record<string, unknown>)
    : {};

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

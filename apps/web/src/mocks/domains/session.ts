/**
 * MSW mock of the session routes (`/me`, `/me/notifications`, `/me/quotas`), typed by the generated OpenAPI types.
 * Notifications and quotas live in `db.data.session`; the signed-in user itself (`db.me`, `db.role`) is shared by
 * every screen and stays on the db root.
 */
import type { HttpHandler } from 'msw';
import type { Res, Schemas } from '@/api/schema';
import {
  HttpResponse,
  latency,
  noContent,
  notFound,
  pageOf,
  route,
  type SampleFactory,
} from '../http';
import { toMeResponse } from '../me-response';
import { getDb, setRole } from '../state';

type Quota = Res<'get', '/me/quotas'>['items'][number];

export type SessionData = {
  notifications: Schemas['Notification'][];
  quotas: Quota[];
};

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ME = 'u-dana';

export const buildSessionData = (now: number): SessionData => ({
  notifications: [
    {
      id: 'n-1',
      userId: ME,
      type: 'setup',
      title: 'GitHub isn’t connected yet',
      data: {
        message: 'Its tools stay out of your AI tools until you sign in.',
        installationId: 'i-github',
      },
      readAt: null,
      createdAt: iso(now - 20 * 60_000),
      updatedAt: iso(now - 20 * 60_000),
    },
    {
      id: 'n-2',
      userId: ME,
      type: 'drift',
      title: 'Tool definition changed',
      data: { message: 'Sentry get_event changed upstream and is waiting for review.' },
      readAt: null,
      createdAt: iso(now - 2 * HOUR),
      updatedAt: iso(now - 2 * HOUR),
    },
    {
      id: 'n-3',
      userId: ME,
      type: 'install_request',
      title: '3 install requests',
      data: { message: 'Raj, Jo and Ana asked for registry servers.' },
      readAt: iso(now - 4 * HOUR),
      createdAt: iso(now - 5 * HOUR),
      updatedAt: iso(now - 4 * HOUR),
    },
  ],
  quotas: [
    {
      ruleId: 'rule-user-calls',
      name: 'Tool calls',
      kind: 'quota',
      subjectId: ME,
      limit: 5000,
      consumed: 1240,
      remaining: 3760,
      resetsAt: iso(now + 8 * HOUR),
    },
    {
      ruleId: 'rule-sandbox-minutes',
      name: 'Sandbox minutes',
      kind: 'quota',
      subjectId: ME,
      limit: 240,
      consumed: 144,
      remaining: 96,
      resetsAt: iso(now + 8 * HOUR),
    },
    {
      ruleId: 'rule-user-concurrency',
      name: 'Concurrent calls',
      kind: 'concurrency',
      subjectId: ME,
      limit: 8,
      consumed: 2,
      remaining: 6,
      resetsAt: null,
    },
  ],
});

const storedRole = () =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('bastion.mockRole');

export const sessionHandlers: HttpHandler[] = [
  route.get('/me', async () => {
    await latency();
    const stored = storedRole();
    if (stored === 'admin' || stored === 'manager' || stored === 'member' || stored === 'auditor')
      setRole(stored);
    return HttpResponse.json(toMeResponse(getDb().me));
  }),
  route.patch('/me', async ({ body }) => {
    const { displayName } = await body();
    const db = getDb();
    if (displayName) db.me.name = displayName;
    return HttpResponse.json(toMeResponse(db.me));
  }),
  route.get('/me/notifications', ({ url }) => {
    const unread = url.searchParams.get('unread') === 'true';
    const rows = getDb()
      .data.session.notifications.filter((n) => !unread || n.readAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json(pageOf(rows, url));
  }),
  route.post('/me/notifications/{id}/read', ({ params }) => {
    const n = getDb().data.session.notifications.find((x) => x.id === params.id);
    if (!n) return notFound('Notification');
    if (!n.readAt) {
      n.readAt = new Date().toISOString();
      n.updatedAt = n.readAt;
    }
    return HttpResponse.json(n);
  }),
  route.get('/me/quotas', () => HttpResponse.json({ items: getDb().data.session.quotas })),
];

export const sessionSamples: SampleFactory = (db) => [
  { method: 'get', path: '/me' },
  { method: 'patch', path: '/me', body: { displayName: 'Dana W.' } },
  { method: 'get', path: '/me/notifications' },
  {
    method: 'post',
    path: `/me/notifications/${db.data.session.notifications[0]?.id ?? 'n-1'}/read`,
  },
  { method: 'get', path: '/me/quotas' },
];

export { noContent };

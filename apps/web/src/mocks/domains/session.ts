/**
 * MSW mock of the session routes (`/me`, `/me/notifications`, `/me/quotas`), typed by the generated OpenAPI types.
 * Notifications and quotas live in `db.data.session`; the signed-in user itself (`db.me`, `db.role`) is shared by
 * every screen and stays on the db root.
 */
import type { HttpHandler } from 'msw';
import type { Res, Schemas } from '@/api/schema';
import {
  checkVersion,
  etagHeaders,
  HttpResponse,
  latency,
  noContent,
  notFound,
  pageOf,
  problem,
  route,
  type SampleFactory,
} from '../http';
import { toMeResponse } from '../me-response';
import { ME_ID, SEED_IDS } from '../seed';
import { getDb, setRole } from '../state';
import { HOUR, iso, nowIso } from '../util';
import { SEEDED_LIMITS } from './settings';

const ME = ME_ID;

/** `remaining` follows from the limit and what is consumed. */
const used = (limit: number, consumed: number) => ({
  limit,
  consumed,
  remaining: limit - consumed,
});
/** Sandbox minutes have no limit rule in the settings seed: the quota stands alone. */
const SANDBOX_MINUTES = 240;

type Quota = Res<'get', '/me/quotas'>['items'][number];

export type SessionData = {
  notifications: Schemas['Notification'][];
  quotas: Quota[];
  /** The apps the signed-in person has authorized (9.4). */
  grants: Schemas['OAuthGrant'][];
};

/** The mock user's password, for trying the change-password form in `pnpm dev`. */
export const MOCK_PASSWORD = 'correct horse battery staple';

export const buildSessionData = (now: number): SessionData => ({
  notifications: [
    {
      id: 'n-1',
      userId: ME,
      type: 'setup',
      title: 'GitHub isn’t connected yet',
      data: {
        message: 'Its tools stay out of your AI tools until you sign in.',
        installationId: SEED_IDS.installation.github,
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
      ...used(SEEDED_LIMITS.callsPerDay, 1240),
      resetsAt: iso(now + 8 * HOUR),
    },
    {
      ruleId: 'rule-sandbox-minutes',
      name: 'Sandbox minutes',
      kind: 'quota',
      subjectId: ME,
      ...used(SANDBOX_MINUTES, 144),
      resetsAt: iso(now + 8 * HOUR),
    },
    {
      ruleId: 'rule-user-concurrency',
      name: 'Concurrent calls',
      kind: 'concurrency',
      subjectId: ME,
      ...used(SEEDED_LIMITS.concurrentCalls, 2),
      resetsAt: null,
    },
  ],
  grants: [
    {
      id: 'g-claude',
      userId: ME,
      clientId: 'https://claude.ai/oauth/client.json',
      scopes: ['mcp', 'offline_access'],
      resources: ['https://bastion.example.com/mcp'],
      expiresAt: iso(now + 20 * 24 * HOUR),
      createdAt: iso(now - 3 * 24 * HOUR),
      updatedAt: iso(now - 3 * 24 * HOUR),
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
    const db = getDb();
    return HttpResponse.json(toMeResponse(db.me, db.meUpdatedAt), {
      headers: etagHeaders(db.meUpdatedAt),
    });
  }),
  route.patch('/me', async ({ request, body }) => {
    const db = getDb();
    const stale = checkVersion(request, { updatedAt: db.meUpdatedAt });
    if (stale) return stale;
    const { displayName } = await body();
    if (displayName) {
      db.me.name = displayName;
      db.meUpdatedAt = nowIso();
    }
    return HttpResponse.json(toMeResponse(db.me, db.meUpdatedAt), {
      headers: etagHeaders(db.meUpdatedAt),
    });
  }),
  route.post('/me/password', async ({ body }) => {
    const { currentPassword, newPassword } = await body();
    if (currentPassword !== MOCK_PASSWORD) {
      return problem(400, 'validation_failed', 'The current password is not correct.', undefined, [
        { path: 'currentPassword', message: 'The current password is not correct.' },
      ]);
    }
    if (newPassword.length < 8) {
      return problem(
        400,
        'validation_failed',
        'The password must be at least 8 characters.',
        undefined,
        [{ path: 'newPassword', message: 'The password must be at least 8 characters.' }],
      );
    }
    return HttpResponse.json({ changed: true as const });
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
      n.readAt = nowIso();
      n.updatedAt = n.readAt;
    }
    return HttpResponse.json(n);
  }),
  route.get('/me/quotas', () => HttpResponse.json({ items: getDb().data.session.quotas })),
  route.get('/me/oauth-grants', ({ url }) => {
    const rows = getDb().data.session.grants;
    return HttpResponse.json(pageOf(rows, url));
  }),
  route.delete('/me/oauth-grants/{id}', ({ params }) => {
    const session = getDb().data.session;
    if (!session.grants.some((g) => g.id === params.id)) return notFound('Grant');
    session.grants = session.grants.filter((g) => g.id !== params.id);
    return noContent();
  }),
];

export const sessionSamples: SampleFactory = (db) => [
  { method: 'get', path: '/me' },
  { method: 'patch', path: '/me', body: { displayName: 'Dana W.' } },
  {
    method: 'post',
    path: '/me/password',
    body: { currentPassword: MOCK_PASSWORD, newPassword: 'another long passphrase' },
  },
  { method: 'get', path: '/me/notifications' },
  {
    method: 'post',
    path: `/me/notifications/${db.data.session.notifications[0]?.id ?? 'n-1'}/read`,
  },
  { method: 'get', path: '/me/quotas' },
  { method: 'get', path: '/me/oauth-grants' },
  { method: 'delete', path: `/me/oauth-grants/${db.data.session.grants[0]?.id ?? 'g-claude'}` },
];

export { noContent };

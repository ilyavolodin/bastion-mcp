import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/api/schema';
import { notificationHref, toNotification, toQuota } from '@/api/views/session';

const row = (over: Partial<Schemas['Notification']>): Schemas['Notification'] => ({
  id: 'n',
  userId: 'u',
  type: 'info',
  title: 'T',
  data: null,
  readAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('session views (18.1)', () => {
  it('18.1 derives the line and the destination of a notification from its type and data', () => {
    const n = toNotification(
      row({ type: 'setup', data: { message: 'Sign in', installationId: 'i-github' } }),
    );
    expect(n.body).toBe('Sign in');
    expect(n.href).toBe('/servers/i-github');
    expect(
      toNotification(row({ type: 'install_request', data: { body: 'Raj asked' } })),
    ).toMatchObject({
      body: 'Raj asked',
      href: '/registry',
    });
    expect(notificationHref(row({ type: 'drift.review' }))).toBe('/security');
    expect(toNotification(row({ type: 'unknown', data: 'oops' }))).toMatchObject({
      body: '',
      href: null,
    });
  });

  it('14 shows concurrency as in use and every other limit as what is left', () => {
    const base = { ruleId: 'r', subjectId: 's', remaining: 1, resetsAt: null };
    expect(toQuota({ ...base, name: 'Calls', kind: 'quota', limit: 10, consumed: 4 })).toEqual({
      id: 'r:s',
      name: 'Calls',
      used: 4,
      limit: 10,
      mode: 'left',
    });
    expect(
      toQuota({ ...base, name: 'Parallel', kind: 'concurrency', limit: 8, consumed: 2 }).mode,
    ).toBe('inUse');
  });
});

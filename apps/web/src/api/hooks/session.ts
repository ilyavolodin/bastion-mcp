import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type { BodyOf } from '../schema';
import { toMe } from '../me';
import { toNotification, toQuota } from '../views/session';
import { keys, pagedQuery, useApiMutation } from './base';

// --- Session and self -----------------------------------------------------------------------------
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get('/me', { signal }).then(toMe),
    staleTime: 5 * 60_000,
    retry: false,
  });

/** `PATCH /me` edits the display name only (17.2); the theme stays in the browser. */
export const useUpdateMe = () =>
  useApiMutation((patch: BodyOf<'patch', '/me'>) => api.patch('/me', patch), [keys.me]);

export const useNotifications = () =>
  useQuery({
    ...pagedQuery(keys.notifications, '/me/notifications', { limit: 50 }),
    select: (rows) => rows.map(toNotification),
  });

export const useMarkNotificationRead = () =>
  useApiMutation(
    (id: string) => api.post(`/me/notifications/${id}/read`),
    [keys.notifications],
  );

export const useQuotas = () =>
  useQuery({
    queryKey: keys.quotas,
    queryFn: ({ signal }) => api.get('/me/quotas', { signal }).then((r) => r.items.map(toQuota)),
  });

import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type { BodyOf } from '../schema';
import { keys, pagedQuery, useApiMutation } from './base';

/** `GET /me/oauth-grants` (9.4): the apps (OAuth clients) the signed-in person has let use their account. */
export const useOAuthGrants = () => useQuery(pagedQuery(keys.grants, '/me/oauth-grants'));

/**
 * `DELETE /me/oauth-grants/{id}` (9.4): the app loses its refresh tokens, so once its short access token ends it has
 * to sign in again, which asks which account it is for.
 */
export const useRevokeOAuthGrant = () =>
  useApiMutation(
    (id: string) => api.delete(`/me/oauth-grants/${encodeURIComponent(id)}`),
    [keys.grants],
  );

/** `POST /me/password` (9.1): the signed-in local user changes their own password; other sessions end. */
export const useChangePassword = () =>
  useApiMutation((body: BodyOf<'post', '/me/password'>) => api.post('/me/password', body));

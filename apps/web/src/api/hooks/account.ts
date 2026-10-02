import { api } from '../client';
import type { BodyOf } from '../schema';
import { useApiMutation } from './base';

/** `POST /me/password` (9.1): the signed-in local user changes their own password; other sessions end. */
export const useChangePassword = () =>
  useApiMutation((body: BodyOf<'post', '/me/password'>) => api.post('/me/password', body));

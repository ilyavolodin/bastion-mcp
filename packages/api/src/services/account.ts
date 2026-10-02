import { parseCookies, SESSION_COOKIE } from '@bastion-mcp/auth';
import { ApiError } from '../errors';
import type { WriteCtx } from './crud';

export type PasswordChangeInput = { currentPassword: string; newPassword: string };

/**
 * `POST /me/password` (9.1): a signed-in local user changes their own password. Wrong current passwords and
 * accounts without a local password both answer with the same field error, so the route reveals nothing else.
 */
export const changeOwnPassword = async (
  ctx: WriteCtx,
  input: PasswordChangeInput,
  cookieHeader: string | undefined,
) => {
  if (ctx.principal.type !== 'user') {
    throw new ApiError('not_supported', 'only user accounts have a password', 422);
  }
  const sessionId =
    ctx.principal.authMethod === 'session'
      ? (parseCookies(cookieHeader)[SESSION_COOKIE] ?? null)
      : null;
  const outcome = await ctx.deps.account.changePassword({
    userId: ctx.principal.id,
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    sessionId,
  });
  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'throttled':
        throw new ApiError('too_many_attempts', 'Too many attempts. Try again later.', 429, {
          data: { retryAfterSeconds: outcome.retryAfterSeconds },
        });
      case 'not_local':
        throw new ApiError(
          'not_supported',
          'This account signs in through your identity provider; change the password there.',
          422,
        );
      case 'invalid_current':
        throw new ApiError('validation_failed', 'The current password is not correct.', 400, {
          errors: [{ path: 'currentPassword', message: 'The current password is not correct.' }],
        });
      case 'policy':
        throw new ApiError('validation_failed', outcome.message, 400, {
          errors: [{ path: 'newPassword', message: outcome.message }],
        });
    }
  }
  await ctx.tx.audit({
    action: 'user.password_change',
    targetType: 'user',
    targetId: ctx.principal.id,
    diff: { changed: ['password'], sessionsRevoked: true },
  });
  return { changed: true as const };
};

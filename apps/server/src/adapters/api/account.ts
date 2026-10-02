/**
 * `AccountPorts` of the control-plane API (9.1): the signed-in local user changes their own password. Wrong current
 * passwords are throttled per account (fixed window in Redis), a success revokes the other sessions and tokens.
 */
import type { AccountPorts } from '@bastion-mcp/api';
import { changeLocalPassword } from '@bastion-mcp/auth';
import type { AuthServices } from '../../contracts';
import type { Infra } from '../../infra';

export const PASSWORD_CHANGE_MAX_FAILURES = 5;
export const PASSWORD_CHANGE_WINDOW_S = 900;

export const createAccountPorts = (
  infra: Infra,
  auth: Pick<AuthServices, 'sessions'>,
): AccountPorts => ({
  async changePassword(input) {
    const key = `rl:pwchange:${input.userId}`;
    const failures = Number(await infra.redis.get(key));
    if (failures >= PASSWORD_CHANGE_MAX_FAILURES) {
      const ttl = await infra.redis.ttl(key);
      return {
        ok: false,
        reason: 'throttled',
        retryAfterSeconds: ttl > 0 ? ttl : PASSWORD_CHANGE_WINDOW_S,
      };
    }
    const result = await changeLocalPassword(
      { users: infra.repos.localAdmins },
      {
        userId: input.userId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      },
      // the route writes the audit event in its own transaction, with the request context
      { audit: false },
    );
    if (!result.ok) {
      if (result.reason === 'invalid_current') {
        const count = await infra.redis.incr(key);
        if (count === 1) await infra.redis.expire(key, PASSWORD_CHANGE_WINDOW_S);
      }
      return result;
    }
    await infra.redis.del(key);
    await auth.sessions.revokeAll(input.userId, input.sessionId ? { keep: input.sessionId } : {});
    return { ok: true };
  },
});

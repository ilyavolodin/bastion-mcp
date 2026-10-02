export type PasswordChangeOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_local' | 'invalid_current' }
  | { ok: false; reason: 'policy'; message: string }
  | { ok: false; reason: 'throttled'; retryAfterSeconds: number };

/**
 * Self-service account operations that touch credentials (9.1): `apps/server` implements them with the argon2id
 * hashing of `@bastion-mcp/secrets`, the attempt throttle and the revocation watermark.
 */
export interface AccountPorts {
  /**
   * Changes the caller's local password after verifying the current one. Revokes the caller's other sessions and
   * tokens; `sessionId` (the cookie of the browser session that asked) stays signed in.
   */
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    sessionId: string | null;
  }): Promise<PasswordChangeOutcome>;
}

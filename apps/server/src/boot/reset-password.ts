import { PatService, type ResetPasswordResult, resetLocalPassword } from '@bastion-mcp/auth';
import { createRevocationStore } from '../adapters/auth';
import type { Infra } from '../infra';

/**
 * `bastion reset-password` (20.1): sets or generates a new local password for a user, then revokes every session,
 * access token and PAT of that user through the revocation watermark (9.1) so nothing issued under the old
 * password survives. The audit event of the change is written with the password itself.
 */
export const resetPassword = async (
  infra: Infra,
  input: { email: string; password?: string | undefined },
): Promise<ResetPasswordResult> => {
  const result = await resetLocalPassword({ users: infra.repos.localAdmins }, input);
  if (!result.ok) return result;
  const pats = new PatService({
    pats: infra.repos.pats,
    revocations: createRevocationStore(infra),
    policy: { patMaxDays: () => infra.repos.orgSettings.patMaxDays() },
  });
  await pats.revokeAll(result.userId);
  return result;
};

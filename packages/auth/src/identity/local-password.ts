import { hashPassword, verifyPassword } from '@bastion-mcp/secrets';
import { generatePassword, type LocalUser, MIN_LOCAL_PASSWORD_LENGTH } from './break-glass';

/** Argon2id hashing cost grows with input size; 256 characters is far beyond any passphrase. */
export const MAX_LOCAL_PASSWORD_LENGTH = 256;

/** The audit actor and action recorded with a password write (17.1: every mutation is audited). */
export type PasswordAudit = {
  action: 'user.password_change' | 'user.password_reset';
  actorType: 'user' | 'system';
  actorId?: string | null;
};

/** Persistence of local passwords; `packages/db` implements it next to `LocalAdminRepository`. */
export interface LocalPasswordRepository {
  findById(id: string): Promise<LocalUser | null>;
  /** Stores the hash and, when `audit` is given, records it in the same transaction. */
  setPasswordHash(input: {
    userId: string;
    passwordHash: string;
    audit?: PasswordAudit;
  }): Promise<void>;
}

/** The most common passwords that satisfy the length rule (compared lowercase, separators removed). */
const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  'letmein123456',
  'qwertyuiop12',
  'qwerty123456',
  '123456789012',
  '1234567890123',
  'iloveyou1234',
  'administrator',
  'administrator1',
  'bastionbastion',
  'changemechangeme',
  'welcome12345',
  'welcome123456',
]);

const squash = (value: string): string => value.toLowerCase().replace(/[\s._-]+/g, '');

/**
 * The local password policy (9.1, 22.3): 12 to 256 characters, different from the current password (which also
 * stops a user keeping the generated bootstrap password), no run of one character, not the name part of the
 * account's e-mail and not one of the most common passwords. Returns the first violation or null.
 */
export const checkPasswordPolicy = (
  password: string,
  context: { email: string; current?: string | undefined },
): string | null => {
  if (password.length < MIN_LOCAL_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_LOCAL_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_LOCAL_PASSWORD_LENGTH) {
    return `The password must be at most ${MAX_LOCAL_PASSWORD_LENGTH} characters.`;
  }
  if (context.current !== undefined && password === context.current) {
    return 'Choose a password different from the current one.';
  }
  if (new Set(password).size < 4) return 'The password must not be a repeat of a few characters.';
  const name = squash(context.email.split('@')[0] ?? '');
  if (name.length >= 4 && squash(password).includes(name)) {
    return 'The password must not contain the name part of your e-mail address.';
  }
  if (COMMON.has(squash(password))) return 'That password is too common. Choose another one.';
  return null;
};

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'not_local' | 'invalid_current' }
  | { ok: false; reason: 'policy'; message: string };

/**
 * Self-service change (9.1): the account must hold a local password and the current one must verify (a
 * deactivated account counts as a wrong password so nothing is learned about it).
 */
export const changeLocalPassword = async (
  deps: { users: LocalPasswordRepository },
  input: { userId: string; currentPassword: string; newPassword: string },
  options: { audit?: boolean } = {},
): Promise<ChangePasswordResult> => {
  const user = await deps.users.findById(input.userId);
  if (!user?.localPasswordHash) return { ok: false, reason: 'not_local' };
  const valid =
    input.currentPassword.length <= MAX_LOCAL_PASSWORD_LENGTH &&
    (await verifyPassword(user.localPasswordHash, input.currentPassword));
  if (!valid || user.status !== 'active') return { ok: false, reason: 'invalid_current' };
  const message = checkPasswordPolicy(input.newPassword, {
    email: user.email,
    current: input.currentPassword,
  });
  if (message !== null) return { ok: false, reason: 'policy', message };
  await deps.users.setPasswordHash({
    userId: user.id,
    passwordHash: await hashPassword(input.newPassword),
    // The control-plane API writes its own audit event (with request context) in the route transaction.
    ...(options.audit === false
      ? {}
      : { audit: { action: 'user.password_change', actorType: 'user', actorId: user.id } }),
  });
  return { ok: true };
};

export type ResetPasswordResult =
  | { ok: true; userId: string; email: string; generatedPassword?: string }
  | { ok: false; reason: 'not_found' | 'not_local' }
  | { ok: false; reason: 'policy'; message: string };

/**
 * Operator reset (`bastion reset-password`, 20.1): sets a supplied password or generates one that is returned once.
 * The caller revokes the user's sessions and tokens.
 */
export const resetLocalPassword = async (
  deps: {
    users: LocalPasswordRepository & {
      findByEmail(email: string): Promise<LocalUser | null>;
    };
    random?: (n: number) => Uint8Array;
  },
  input: { email: string; password?: string | undefined },
): Promise<ResetPasswordResult> => {
  const email = input.email.trim().toLowerCase();
  const user = await deps.users.findByEmail(email);
  if (!user) return { ok: false, reason: 'not_found' };
  if (!user.localPasswordHash) return { ok: false, reason: 'not_local' };
  if (input.password !== undefined) {
    const message = checkPasswordPolicy(input.password, { email: user.email });
    if (message !== null) return { ok: false, reason: 'policy', message };
  }
  const password = input.password ?? generatePassword(deps.random);
  await deps.users.setPasswordHash({
    userId: user.id,
    passwordHash: await hashPassword(password),
    audit: { action: 'user.password_reset', actorType: 'system' },
  });
  return {
    ok: true,
    userId: user.id,
    email: user.email,
    ...(input.password === undefined ? { generatedPassword: password } : {}),
  };
};

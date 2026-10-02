import { randomBytes } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { hashPassword, verifyPassword } from '@bastion-mcp/secrets';
import { IdentityValidationError } from './errors';
import { base62Encode } from './pat/token';
import type { OrgRole } from './principal';

export const MIN_LOCAL_PASSWORD_LENGTH = 12;

export type BootstrapDecision =
  | { action: 'create'; email: string }
  | { action: 'skip'; reason: 'not_configured' | 'invalid_email' | 'already_exists' };

/** 9.1: `BASTION_BOOTSTRAP_ADMIN_EMAIL` creates the local admin once, on first start. */
export const planBootstrapAdmin = (input: {
  bootstrapEmail: string | undefined;
  existingUserId: string | null;
}): BootstrapDecision => {
  const email = input.bootstrapEmail?.trim().toLowerCase();
  if (!email) return { action: 'skip', reason: 'not_configured' };
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { action: 'skip', reason: 'invalid_email' };
  if (input.existingUserId !== null) return { action: 'skip', reason: 'already_exists' };
  return { action: 'create', email };
};

/** 9.1: local password login only while no IdP connection exists or `BASTION_LOCAL_LOGIN=true`. */
export const localLoginEnabled = (input: {
  idpConnectionCount: number;
  localLoginFlag: boolean;
}): boolean => input.idpConnectionCount === 0 || input.localLoginFlag;

export type LocalUser = {
  id: string;
  email: string;
  orgRole: OrgRole;
  status: 'active' | 'deactivated';
  localPasswordHash: string | null;
};

export interface LocalAdminRepository {
  findByEmail(email: string): Promise<LocalUser | null>;
  createLocalAdmin(input: {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<void>;
}

export const generatePassword = (random: (n: number) => Uint8Array = randomBytes): string =>
  base62Encode(random(24), 33);

/**
 * Creates the break-glass admin when needed (22.3: argon2id hash). A generated password is returned once
 * so the caller can print it on first start; a supplied password is never returned.
 */
export const bootstrapAdmin = async (
  deps: { users: LocalAdminRepository; random?: (n: number) => Uint8Array },
  input: { email: string | undefined; password?: string },
): Promise<{ created: boolean; email?: string; generatedPassword?: string }> => {
  const email = input.email?.trim().toLowerCase();
  const existing = email ? await deps.users.findByEmail(email) : null;
  const decision = planBootstrapAdmin({
    bootstrapEmail: input.email,
    existingUserId: existing?.id ?? null,
  });
  if (decision.action === 'skip') return { created: false };
  if (input.password !== undefined && input.password.length < MIN_LOCAL_PASSWORD_LENGTH) {
    throw new IdentityValidationError(
      `password must be at least ${MIN_LOCAL_PASSWORD_LENGTH} characters`,
    );
  }
  const password = input.password ?? generatePassword(deps.random);
  await deps.users.createLocalAdmin({
    id: newId(),
    email: decision.email,
    displayName: 'Administrator',
    passwordHash: await hashPassword(password),
  });
  return {
    created: true,
    email: decision.email,
    ...(input.password === undefined ? { generatedPassword: password } : {}),
  };
};

let dummyHash: Promise<string> | undefined;

/**
 * Local password login (break-glass). Null for every failure; a dummy hash is verified for unknown or
 * password-less accounts so timing does not reveal which emails exist.
 */
export const verifyLocalLogin = async (
  deps: { users: LocalAdminRepository },
  policy: { idpConnectionCount: number; localLoginFlag: boolean },
  email: string,
  password: string,
): Promise<LocalUser | null> => {
  if (!localLoginEnabled(policy)) return null;
  const user = await deps.users.findByEmail(email.trim().toLowerCase());
  if (!user?.localPasswordHash) {
    dummyHash ??= hashPassword('bastion-dummy-password');
    await verifyPassword(await dummyHash, password);
    return null;
  }
  const ok = await verifyPassword(user.localPasswordHash, password);
  return ok && user.status === 'active' ? user : null;
};

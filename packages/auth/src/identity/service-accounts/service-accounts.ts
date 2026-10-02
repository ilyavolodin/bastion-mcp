import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BastionError, isValidSlug, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import { IdentityValidationError } from '../errors';
import { base62Encode } from '../pat/token';
import { type Clock, systemClock } from '../ports';
import type { Principal, PrincipalRecord } from '../principal';

export const CLIENT_SECRET_PREFIX = 'bst_sec_';
export const CLIENT_ID_PREFIX = 'sa_';

export type ServiceAccountAuthMethod = 'client_secret_basic' | 'private_key_jwt';

/** A `service_accounts` row (16.2). */
export type ServiceAccount = {
  id: string;
  teamId: string;
  slug: string;
  displayName: string;
  status: 'active' | 'disabled';
  oauthClientId: string | null;
  createdAt: Date;
};

export type PublicJwk = Record<string, string>;

/** The OAuth client of a service account; the authorization server reads it for `client_credentials` (9.3). */
export type ServiceAccountClient = {
  clientId: string;
  serviceAccountId: string;
  authMethod: ServiceAccountAuthMethod;
  /** Lowercase hex SHA-256 of the high-entropy secret (`client_secret_basic`). */
  secretSha256: string | null;
  /** Public keys for `private_key_jwt`. */
  jwks: PublicJwk[] | null;
};

/** Port implemented by `@bastion-mcp/db`; consumed by the authorization server and the API. */
export interface ServiceAccountDirectory {
  findByClientId(
    clientId: string,
  ): Promise<{ account: ServiceAccount; client: ServiceAccountClient } | null>;
  findById(id: string): Promise<ServiceAccount | null>;
  listByTeam(teamId: string): Promise<ServiceAccount[]>;
  /** Inserts the account and its client atomically. */
  create(account: ServiceAccount, client: ServiceAccountClient): Promise<void>;
  saveClient(client: ServiceAccountClient): Promise<void>;
  setStatus(id: string, status: ServiceAccount['status']): Promise<void>;
}

const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');

export const generateClientSecret = (random: (n: number) => Uint8Array = randomBytes): string =>
  `${CLIENT_SECRET_PREFIX}${base62Encode(random(32), 43)}`;

export const hashClientSecret = sha256Hex;

/** Constant-time comparison of a presented secret with the stored hash. */
export const verifyClientSecret = (
  client: Pick<ServiceAccountClient, 'secretSha256'>,
  presented: string,
): boolean => {
  if (!client.secretSha256) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(client.secretSha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const jwkSchema = z
  .record(z.string(), z.string())
  .refine((k) => !('d' in k) && !('p' in k) && !('q' in k) && !('k' in k), 'private key material')
  .refine(
    (k) =>
      (k.kty === 'EC' && k.crv === 'P-256' && !!k.x && !!k.y) ||
      (k.kty === 'RSA' && !!k.n && !!k.e),
    'unsupported key',
  );

/** `private_key_jwt` keys must be public ES256 (P-256) or RSA keys. */
export const validateClientJwks = (jwks: unknown): PublicJwk[] => {
  const parsed = z.array(jwkSchema).min(1).max(5).safeParse(jwks);
  if (!parsed.success) throw new IdentityValidationError('invalid public keys for private_key_jwt');
  return parsed.data;
};

export type CreateServiceAccountInput = {
  teamId: string;
  slug: string;
  displayName: string;
  authMethod: ServiceAccountAuthMethod;
  jwks?: unknown;
};

export type CreatedServiceAccount = {
  account: ServiceAccount;
  client: ServiceAccountClient;
  /** Returned once; only for `client_secret_basic`. */
  clientSecret?: string;
};

/** Creates a service account owned by a team with its `client_credentials` client (9.3). */
export const createServiceAccount = async (
  deps: { directory: ServiceAccountDirectory; clock?: Clock; random?: (n: number) => Uint8Array },
  input: CreateServiceAccountInput,
): Promise<CreatedServiceAccount> => {
  if (!isValidSlug(input.slug)) throw new IdentityValidationError('invalid service account slug');
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 100)
    throw new IdentityValidationError('invalid display name');
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? randomBytes;
  const id = newId(clock.now());
  const clientId = `${CLIENT_ID_PREFIX}${Buffer.from(random(12)).toString('base64url')}`;
  const secret =
    input.authMethod === 'client_secret_basic' ? generateClientSecret(random) : undefined;
  const client: ServiceAccountClient = {
    clientId,
    serviceAccountId: id,
    authMethod: input.authMethod,
    secretSha256: secret ? hashClientSecret(secret) : null,
    jwks: input.authMethod === 'private_key_jwt' ? validateClientJwks(input.jwks) : null,
  };
  const account: ServiceAccount = {
    id,
    teamId: input.teamId,
    slug: input.slug,
    displayName,
    status: 'active',
    oauthClientId: clientId,
    createdAt: new Date(clock.now()),
  };
  await deps.directory.create(account, client);
  return { account, client, ...(secret ? { clientSecret: secret } : {}) };
};

/** Issues a new secret and invalidates the old one. */
export const rotateClientSecret = async (
  deps: { directory: ServiceAccountDirectory; random?: (n: number) => Uint8Array },
  clientId: string,
): Promise<string | null> => {
  const found = await deps.directory.findByClientId(clientId);
  if (found?.client.authMethod !== 'client_secret_basic') return null;
  const secret = generateClientSecret(deps.random);
  await deps.directory.saveClient({ ...found.client, secretSha256: hashClientSecret(secret) });
  return secret;
};

/** `client_secret_basic` check for the token endpoint; null on any failure (no oracle). */
export const authenticateClientSecret = async (
  directory: ServiceAccountDirectory,
  clientId: string,
  secret: string,
): Promise<ServiceAccount | null> => {
  const found = await directory.findByClientId(clientId);
  if (found?.client.authMethod !== 'client_secret_basic') return null;
  if (!verifyClientSecret(found.client, secret) || found.account.status !== 'active') return null;
  return found.account;
};

/** The principal record for a service account: type `service`, `member` capabilities, its owning team (10.1). */
export const serviceAccountPrincipal = (account: ServiceAccount): PrincipalRecord => ({
  id: account.id,
  type: 'service',
  orgRole: 'member',
  teams: [{ teamId: account.teamId, role: 'member' }],
  active: account.status === 'active',
});

export type UpstreamAuthMode =
  | 'none'
  | 'orgSecret'
  | 'userSecret'
  | 'oauth'
  | 'enterpriseManaged'
  | 'tokenExchange';

export class InteractiveOAuthNotAllowedError extends BastionError {
  constructor(mode: UpstreamAuthMode) {
    super(
      'SERVICE_ACCOUNT_NO_INTERACTIVE_OAUTH',
      `service accounts cannot use upstream auth mode ${mode}`,
      {
        httpStatus: 403,
        data: { mode },
      },
    );
  }
}

/**
 * 9.3: service accounts cannot use interactive upstream OAuth. Allowed: `none`, `orgSecret`, `userSecret`
 * (the account's own secret) and `tokenExchange` only with a configured subject token.
 */
export const upstreamAuthModeAllowed = (
  principal: Pick<Principal, 'type'>,
  mode: UpstreamAuthMode,
  opts: { subjectTokenConfigured?: boolean } = {},
): boolean => {
  if (principal.type !== 'service') return true;
  switch (mode) {
    case 'oauth':
    case 'enterpriseManaged':
      return false;
    case 'tokenExchange':
      return opts.subjectTokenConfigured === true;
    default:
      return true;
  }
};

export const assertUpstreamAuthAllowed = (
  principal: Pick<Principal, 'type'>,
  mode: UpstreamAuthMode,
  opts: { subjectTokenConfigured?: boolean } = {},
): void => {
  if (!upstreamAuthModeAllowed(principal, mode, opts))
    throw new InteractiveOAuthNotAllowedError(mode);
};

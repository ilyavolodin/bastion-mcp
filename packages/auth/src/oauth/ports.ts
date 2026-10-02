import type { SigningKeyMeta } from '@bastion-mcp/secrets';

/** Injectable time source (epoch milliseconds). */
export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

/** The subset of a Redis client the OAuth layer uses. TTLs are seconds. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export type FetchFn = typeof fetch;

// --- oidc_models (16.2) ----------------------------------------------------------------------------
export type OidcModelRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  grantId: string | null;
  userCode: string | null;
  uid: string | null;
  expiresAt: Date | null;
  consumedAt: Date | null;
};

/** Storage behind the oidc-provider adapter; one row per (type, id). */
export interface OidcModelStore {
  upsert(row: OidcModelRow): Promise<void>;
  find(type: string, id: string): Promise<OidcModelRow | null>;
  findByUid(type: string, uid: string): Promise<OidcModelRow | null>;
  findByUserCode(type: string, userCode: string): Promise<OidcModelRow | null>;
  consume(type: string, id: string, at: Date): Promise<void>;
  destroy(type: string, id: string): Promise<void>;
  /** Deletes every row whose `grant_id` matches (any type). */
  revokeByGrantId(grantId: string): Promise<void>;
}

// --- signing_keys (16.2) -----------------------------------------------------------------------------
export interface SigningKeySource {
  listSigningKeys(purpose: 'as' | 'upstream-client'): Promise<SigningKeyMeta[]>;
  loadSigningPrivateKey(kid: string): Promise<Record<string, string>>;
}

// --- oauth_client_policies (16.2) -------------------------------------------------------------------
export type OAuthClientPolicy = { clientId: string; preApproved: boolean; blocked: boolean };
export interface OAuthClientPolicyStore {
  get(clientId: string): Promise<OAuthClientPolicy | null>;
  list(): Promise<OAuthClientPolicy[]>;
  upsert(policy: OAuthClientPolicy, updatedBy: string): Promise<void>;
}

/** `settings.clientRegistration` (9.3). */
export type ClientRegistrationSettings = {
  cimd: boolean;
  dcr: boolean;
  /** Empty means any https host. */
  cimdHostAllowlist: readonly string[];
};
export interface RegistrationSettingsSource {
  get(): Promise<ClientRegistrationSettings>;
}

/** Who a token subject is: a user (interactive) or a service account (client_credentials). */
export interface PrincipalDirectory {
  /** True when the user exists and is active. */
  isUserActive(userId: string): Promise<boolean>;
  /** Service account owning an OAuth client, or null. */
  serviceAccountForClient(clientId: string): Promise<{ id: string } | null>;
}

// --- IdP (9.1) -----------------------------------------------------------------------------------
export type ClaimMap = { email: string; name: string; groups: string; sub: string };

export type IdpConnection = {
  id: string;
  name: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretId: string;
  scopes: readonly string[];
  claimMap: ClaimMap;
  emailDomains: readonly string[];
  storeRefreshToken: boolean;
  apiScope: string | null;
  enterpriseManagedAuth: boolean;
  enabled: boolean;
};
export interface IdpConnectionStore {
  get(id: string): Promise<IdpConnection | null>;
  list(): Promise<IdpConnection[]>;
}

export type IdpTokenRow = {
  userId: string;
  idpConnectionId: string;
  secretId: string;
  expiresAt: Date | null;
  updatedAt: Date;
};
export interface IdpTokenStore {
  get(userId: string, idpConnectionId: string): Promise<IdpTokenRow | null>;
  put(row: IdpTokenRow): Promise<void>;
  delete(userId: string, idpConnectionId: string): Promise<void>;
}

/** Envelope-encrypted values (secrets table through `SecretVault`). Values never leave the process. */
export type SecretRef = {
  scope: 'org' | 'team' | 'user' | 'system';
  ownerId: string | null;
  name: string;
};
export interface SecretStore {
  put(ref: SecretRef, value: string): Promise<{ id: string }>;
  reveal(ref: SecretRef): Promise<string | null>;
  /** Reveal by secret id (`client_secret_id`, `secret_id` columns). */
  revealById(id: string): Promise<string | null>;
  delete(ref: SecretRef): Promise<void>;
}

// --- upstream (9.6) -----------------------------------------------------------------------------------
export type UpstreamClientRow = {
  issuer: string;
  registration: 'preRegistered' | 'cimd' | 'dcr';
  clientId: string;
  clientSecretId: string | null;
  metadata: Record<string, unknown>;
};
export interface UpstreamClientStore {
  get(issuer: string): Promise<UpstreamClientRow | null>;
  put(row: UpstreamClientRow): Promise<void>;
  delete(issuer: string): Promise<void>;
}

export type PrincipalType = 'user' | 'service';
export type UpstreamTokenStatus = 'valid' | 'reconnect_required';
export type UpstreamTokenRow = {
  principalType: PrincipalType;
  principalId: string;
  installationId: string;
  issuer: string;
  secretId: string;
  scopes: readonly string[];
  expiresAt: Date | null;
  status: UpstreamTokenStatus;
  updatedAt: Date;
};
export interface UpstreamTokenStore {
  get(principalId: string, installationId: string): Promise<UpstreamTokenRow | null>;
  put(row: UpstreamTokenRow): Promise<void>;
  delete(principalId: string, installationId: string): Promise<void>;
  /** Rows expiring before `before` that are still `valid` (daily sweep). */
  listExpiringBefore(before: Date): Promise<UpstreamTokenRow[]>;
  listByInstallation(installationId: string): Promise<UpstreamTokenRow[]>;
  /** Every installation token of one principal (deactivation, 9.1). */
  listByPrincipal(principalId: string): Promise<UpstreamTokenRow[]>;
}

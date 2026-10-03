import { MS, SCOPES, SECONDS } from '@bastion-mcp/core';

export const BASTION_SCOPES = [
  SCOPES.mcp,
  SCOPES.apiRead,
  SCOPES.apiWrite,
  SCOPES.pluginsRead,
  SCOPES.offlineAccess,
] as const;

export const CREDENTIAL_CLIENT_ID = 'bastion-credential';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const ENTERPRISE_MANAGED_EXTENSION =
  'io.modelcontextprotocol/enterprise-managed-authorization';

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_IDLE_TTL_S = 7 * 24 * 60 * 60;
export const REFRESH_ABSOLUTE_TTL_S = 30 * 24 * 60 * 60;
export const CONSENT_TTL_S = 90 * 24 * 60 * 60;
export const DCR_LIMIT_PER_HOUR = 10;
export const UPSTREAM_STATE_TTL_S = 10 * 60;
export const UPSTREAM_REFRESH_WINDOW_S = 5 * 60;
export const ENTERPRISE_TOKEN_SKEW_S = 60;

/** Upstream discovery results are cached this long, and at most `DISCOVERY_CACHE_MAX` of them. */
export const DISCOVERY_TTL_MS = 10 * MS.MINUTE;
export const DISCOVERY_CACHE_MAX = 256;
/** How long a recorded step-up scope set waits for the user to reconnect. */
export const STEP_UP_TTL_S = SECONDS.HOUR;
/** The daily sweep refreshes tokens that expire within this window. */
export const SWEEP_WINDOW_MS = MS.DAY;
export const LOGIN_STATE_TTL_MS = 10 * MS.MINUTE;
export const LOGIN_CONFIG_TTL_MS = 10 * MS.MINUTE;
export const JWKS_TTL_MS = 5 * MS.MINUTE;
export const TOKEN_SKEW_MS = MS.MINUTE;

/** Outbound timeouts of the OAuth layer. */
export const OAUTH_TIMEOUTS_MS = {
  /** Whole request through the SSRF-guarded fetch. */
  request: 10_000,
  /** TCP connect of a pinned dispatcher. */
  connect: 10_000,
  /** Idle keep-alive of a pinned dispatcher. */
  keepAlive: 10_000,
} as const;
/** Pinned dispatchers kept open at once. */
export const MAX_PINNED_AGENTS = 64;

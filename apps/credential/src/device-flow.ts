import { SCOPES } from '@bastion-mcp/core';
import { z } from 'zod';
import { CredentialError } from './config';

export const CLIENT_ID = 'bastion-credential';
export const REQUESTED_SCOPE = `${SCOPES.pluginsRead} ${SCOPES.offlineAccess}`;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OAuthEndpoints = { deviceAuthorization: string; token: string };

const discoverySchema = z.object({
  device_authorization_endpoint: z.string().optional(),
  token_endpoint: z.string(),
});

/** Endpoints of the authorization server at `<server>/oauth` (OIDC discovery, then the defaults). */
export const discoverEndpoints = async (server: URL, fetchFn: FetchFn): Promise<OAuthEndpoints> => {
  const issuer = `${server.origin}/oauth`;
  const fallback = { deviceAuthorization: `${issuer}/device/auth`, token: `${issuer}/token` };
  try {
    const response = await fetchFn(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return fallback;
    const parsed = discoverySchema.safeParse(await response.json());
    if (!parsed.success) return fallback;
    return {
      deviceAuthorization:
        parsed.data.device_authorization_endpoint ?? fallback.deviceAuthorization,
      token: parsed.data.token_endpoint,
    };
  } catch {
    return fallback;
  }
};

const deviceAuthSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});
export type DeviceAuthorization = z.infer<typeof deviceAuthSchema>;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenSchema>;

const errorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

const postForm = async (
  fetchFn: FetchFn,
  url: string,
  body: Record<string, string>,
): Promise<{ ok: boolean; json: unknown }> => {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => undefined);
  return { ok: response.ok, json };
};

/** RFC 8628 section 3.1. */
export const requestDeviceAuthorization = async (
  endpoints: OAuthEndpoints,
  fetchFn: FetchFn,
): Promise<DeviceAuthorization> => {
  const { ok, json } = await postForm(fetchFn, endpoints.deviceAuthorization, {
    client_id: CLIENT_ID,
    scope: REQUESTED_SCOPE,
  });
  const parsed = deviceAuthSchema.safeParse(json);
  if (!ok || !parsed.success) {
    throw new CredentialError('the authorization server refused the device authorization request');
  }
  return parsed.data;
};

export type PollDeps = {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * RFC 8628 section 3.5: polls the token endpoint at the server's interval, adding 5 seconds on
 * `slow_down`, continuing on `authorization_pending`, and failing on `expired_token`/`access_denied`.
 */
export const pollForToken = async (
  endpoints: OAuthEndpoints,
  authorization: DeviceAuthorization,
  deps: PollDeps,
): Promise<TokenResponse> => {
  let intervalS = authorization.interval ?? DEFAULT_INTERVAL_S;
  const deadline = deps.now() + authorization.expires_in * 1000;
  for (;;) {
    await deps.sleep(intervalS * 1000);
    if (deps.now() > deadline)
      throw new CredentialError('the device code expired; run the command again');
    const { json } = await postForm(deps.fetch, endpoints.token, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: authorization.device_code,
      client_id: CLIENT_ID,
    });
    const token = tokenSchema.safeParse(json);
    if (token.success) return token.data;
    const error = errorSchema.safeParse(json);
    switch (error.success ? error.data.error : undefined) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalS += SLOW_DOWN_STEP_S;
        continue;
      case 'expired_token':
        throw new CredentialError('the device code expired; run the command again');
      case 'access_denied':
        throw new CredentialError('the sign-in was denied');
      default:
        throw new CredentialError(
          `unexpected token response${error.success ? `: ${error.data.error}` : ''}`,
        );
    }
  }
};

/** Only `invalid_grant` (RFC 6749 5.2) says the refresh token itself is dead; everything else is not the token's fault. */
export const isTerminalRefreshError = (error: string | undefined): boolean =>
  error === 'invalid_grant';

/**
 * Refresh-token grant. Returns `undefined` only when the refresh token is no longer valid
 * (`invalid_grant`); any other failure, including `invalid_request`/`invalid_client` (a configuration
 * problem), throws so the caller keeps the stored credential.
 */
export const refreshAccessToken = async (
  endpoints: OAuthEndpoints,
  refreshToken: string,
  fetchFn: FetchFn,
): Promise<TokenResponse | undefined> => {
  const { ok, json } = await postForm(fetchFn, endpoints.token, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: REQUESTED_SCOPE,
  });
  const token = tokenSchema.safeParse(json);
  if (ok && token.success) return token.data;
  const error = errorSchema.safeParse(json);
  if (isTerminalRefreshError(error.success ? error.data.error : undefined)) return undefined;
  throw new CredentialError('the authorization server could not refresh the token');
};

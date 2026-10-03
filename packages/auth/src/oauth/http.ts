import * as client from 'openid-client';
import type { FetchFn } from './ports';

/** Options shared by every module that talks to an authorization server through openid-client. */
export type OAuthHttpOptions = {
  /** Already wrapped with `createSafeFetch` in production. */
  fetch: FetchFn;
  /** Lets openid-client call http endpoints. Tests and admin-allowed internal IdPs only. */
  allowInsecureHttp?: boolean;
};

export type ClientAuthKind =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt'
  | 'none';

const toCustomFetch =
  (fetchFn: FetchFn): client.CustomFetch =>
  (url, init) =>
    fetchFn(url, init as RequestInit);

/**
 * openid-client takes the `redirect_uri` of the code exchange from a parsed URL, and `new URL('https://host')` is
 * `https://host/`. RFC 6749 4.1.3 wants the exchange to repeat the authorization request's value exactly, and an IdP
 * that registers only the origin compares the text, so the slash is taken off again on the way out.
 */
export const withRedirectUriAsSent =
  (fetchFn: FetchFn, redirectUri: string): FetchFn =>
  (input, init) => {
    const normalized = new URL(redirectUri).href;
    const body = init?.body;
    if (
      normalized !== redirectUri &&
      body instanceof URLSearchParams &&
      body.get('redirect_uri') === normalized
    ) {
      const next = new URLSearchParams(body);
      next.set('redirect_uri', redirectUri);
      return fetchFn(input, { ...init, body: next });
    }
    return fetchFn(input, init);
  };

/** Builds an openid-client Configuration bound to the injected fetch. */
export const buildConfiguration = (
  metadata: client.ServerMetadata,
  clientId: string,
  auth: client.ClientAuth,
  options: OAuthHttpOptions,
): client.Configuration => {
  const config = new client.Configuration(metadata, clientId, undefined, auth);
  config[client.customFetch] = toCustomFetch(options.fetch);
  if (options.allowInsecureHttp) client.allowInsecureRequests(config);
  return config;
};

export const discoveryOptions = (options: OAuthHttpOptions): client.DiscoveryRequestOptions => ({
  [client.customFetch]: toCustomFetch(options.fetch),
  ...(options.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : {}),
});

export class OAuthProtocolError extends Error {
  readonly error: string | undefined;
  readonly description: string | undefined;
  readonly status: number | undefined;
  constructor(
    message: string,
    details: { error?: string; description?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'OAuthProtocolError';
    this.error = details.error;
    this.description = details.description;
    this.status = details.status;
  }
}

/** Normalizes openid-client / oauth4webapi failures: protocol errors keep `error` and its description. */
export const toProtocolError = (error: unknown, context: string): OAuthProtocolError => {
  if (error instanceof OAuthProtocolError) return error;
  if (error instanceof client.ResponseBodyError) {
    return new OAuthProtocolError(`${context}: ${error.error}`, {
      error: error.error,
      ...(error.error_description ? { description: error.error_description } : {}),
      status: error.status,
    });
  }
  if (error instanceof client.AuthorizationResponseError) {
    return new OAuthProtocolError(`${context}: authorization response error`, {
      error: error.error,
      ...(error.error_description ? { description: error.error_description } : {}),
    });
  }
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const message = cause ?? (error instanceof Error ? error.message : 'unknown error');
  return new OAuthProtocolError(`${context}: ${message}`);
};

export const selectClientAuth = (
  methods: readonly string[] | undefined,
  secret: string,
): client.ClientAuth => {
  if (!methods || methods.includes('client_secret_basic')) return client.ClientSecretBasic(secret);
  if (methods.includes('client_secret_post')) return client.ClientSecretPost(secret);
  return client.ClientSecretBasic(secret);
};

/** RFC 9207: when the response carries `iss` it must equal the recorded issuer; some servers must send it. */
export const checkIssuerParameter = (
  params: URLSearchParams,
  expectedIssuer: string,
  required: boolean,
): void => {
  const iss = params.get('iss');
  if (iss === null) {
    if (required) throw new OAuthProtocolError('authorization response is missing iss (RFC 9207)');
    return;
  }
  if (iss !== expectedIssuer) {
    throw new OAuthProtocolError('authorization response iss does not match the issuer (RFC 9207)');
  }
};

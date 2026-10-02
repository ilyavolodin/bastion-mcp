import { type Keyring, openJson, sealJson } from '@bastion-mcp/core';
import * as client from 'openid-client';
import { z } from 'zod';
import {
  buildConfiguration,
  checkIssuerParameter,
  discoveryOptions,
  type OAuthHttpOptions,
  OAuthProtocolError,
  selectClientAuth,
  toProtocolError,
} from '../http';
import {
  type Clock,
  type IdpConnection,
  type IdpConnectionStore,
  type SecretStore,
  systemClock,
} from '../ports';
import { idpCallbackUrl } from '../urls';
import { IdpClaimError, loginScopes, mapClaims, type NormalizedProfile } from './profile';

const STATE_PREFIX = 'bls1.';
const STATE_TTL_MS = 10 * 60 * 1000;
const CONFIG_TTL_MS = 10 * 60 * 1000;

export type IdpTokenSet = {
  accessToken: string;
  idToken: string | null;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number | null;
  scope: string | null;
};

export class IdpLoginError extends Error {
  constructor(
    message: string,
    readonly reason: 'state' | 'idp' | 'claims' | 'config',
  ) {
    super(message);
    this.name = 'IdpLoginError';
  }
}

export type IdpDeps = OAuthHttpOptions & {
  host: string;
  connections: IdpConnectionStore;
  secrets: SecretStore;
  clock?: Clock;
};

export type IdpLoginDeps = IdpDeps & { stateKeyring: Keyring };

const loginState = z.object({
  v: z.literal(1),
  c: z.string(),
  s: z.string(),
  n: z.string(),
  p: z.string(),
  r: z.string().nullable(),
  x: z.number(),
});

export type LoginStart = { authorizationUrl: string; stateToken: string };
export type LoginResult = {
  profile: NormalizedProfile;
  connection: IdpConnection;
  tokens: IdpTokenSet;
  returnTo: string | null;
};

export const toTokenSet = (
  response: client.TokenEndpointResponse,
  nowMs: number,
  previous?: IdpTokenSet,
): IdpTokenSet => ({
  accessToken: response.access_token,
  idToken: typeof response.id_token === 'string' ? response.id_token : null,
  refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
  expiresAt: typeof response.expires_in === 'number' ? nowMs + response.expires_in * 1000 : null,
  scope: response.scope ?? previous?.scope ?? null,
});

type CachedConfig = { config: client.Configuration; at: number; key: string };

/** Shared by login and the token refresh path: discovery per connection, cached 10 minutes. */
export class IdpClients {
  private readonly cache = new Map<string, CachedConfig>();
  protected readonly clock: Clock;
  constructor(protected readonly deps: IdpDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async connection(id: string): Promise<IdpConnection> {
    const found = await this.deps.connections.get(id);
    if (!found?.enabled) throw new IdpLoginError('unknown or disabled IdP connection', 'config');
    return found;
  }

  async configuration(connection: IdpConnection): Promise<client.Configuration> {
    const key = `${connection.discoveryUrl}|${connection.clientId}|${connection.clientSecretId}`;
    const cached = this.cache.get(connection.id);
    if (cached && cached.key === key && this.clock.now() - cached.at < CONFIG_TTL_MS)
      return cached.config;
    const secret = await this.deps.secrets.revealById(connection.clientSecretId);
    if (!secret) throw new IdpLoginError('IdP client secret is missing', 'config');
    const issuerUrl = new URL(
      connection.discoveryUrl.replace(/\/\.well-known\/openid-configuration\/?$/, ''),
    );
    let discovered: client.Configuration;
    try {
      discovered = await client.discovery(
        issuerUrl,
        connection.clientId,
        undefined,
        client.ClientSecretBasic(secret),
        discoveryOptions(this.deps),
      );
    } catch (error) {
      throw toProtocolError(error, 'IdP discovery failed');
    }
    const metadata = discovered.serverMetadata();
    if (metadata.issuer !== connection.issuer) {
      throw new IdpLoginError('IdP issuer does not match the connection', 'config');
    }
    const config = buildConfiguration(
      metadata,
      connection.clientId,
      selectClientAuth(metadata.token_endpoint_auth_methods_supported, secret),
      this.deps,
    );
    this.cache.set(connection.id, { config, at: this.clock.now(), key });
    return config;
  }
}

/** OIDC login against any IdP (9.1): discovery, authorization code + PKCE, state and nonce, `iss` check. */
export class IdpLogin extends IdpClients {
  constructor(protected override readonly deps: IdpLoginDeps) {
    super(deps);
  }

  async startLogin(
    connectionId: string,
    options: { returnTo?: string; loginHint?: string } = {},
  ): Promise<LoginStart> {
    const connection = await this.connection(connectionId);
    const config = await this.configuration(connection);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: idpCallbackUrl(this.deps.host, connection.id),
      scope: loginScopes(connection).join(' '),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    });
    const stateToken = sealJson(
      {
        v: 1,
        c: connection.id,
        s: state,
        n: nonce,
        p: verifier,
        r: options.returnTo ?? null,
        x: this.clock.now() + STATE_TTL_MS,
      },
      this.deps.stateKeyring,
      { prefix: STATE_PREFIX, aad: connection.id },
    );
    return { authorizationUrl: url.href, stateToken };
  }

  /** `query` is the raw query string of the callback request; `stateToken` the cookie from `startLogin`. */
  async completeLogin(
    connectionId: string,
    query: string,
    stateToken: string,
  ): Promise<LoginResult> {
    const connection = await this.connection(connectionId);
    let state: z.infer<typeof loginState>;
    try {
      state = loginState.parse(
        openJson(stateToken, this.deps.stateKeyring, { prefix: STATE_PREFIX, aad: connectionId }),
      );
    } catch {
      throw new IdpLoginError('invalid login state', 'state');
    }
    if (state.c !== connection.id || state.x < this.clock.now()) {
      throw new IdpLoginError('login state expired', 'state');
    }
    const params = new URLSearchParams(query);
    if (params.get('state') !== state.s) throw new IdpLoginError('state mismatch', 'state');
    const error = params.get('error');
    if (error) throw new IdpLoginError(`IdP returned ${error}`, 'idp');
    const config = await this.configuration(connection);
    const metadata = config.serverMetadata();
    try {
      checkIssuerParameter(
        params,
        connection.issuer,
        metadata.authorization_response_iss_parameter_supported === true,
      );
    } catch (e) {
      throw new IdpLoginError(e instanceof Error ? e.message : 'issuer check failed', 'idp');
    }
    const callback = new URL(idpCallbackUrl(this.deps.host, connection.id));
    callback.search = params.toString();
    let response: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
    try {
      response = await client.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: state.p,
        expectedState: state.s,
        expectedNonce: state.n,
        idTokenExpected: true,
      });
    } catch (e) {
      throw new IdpLoginError(toProtocolError(e, 'IdP code exchange failed').message, 'idp');
    }
    const claims = response.claims();
    if (!claims) throw new IdpLoginError('IdP returned no ID token', 'idp');
    let profile: NormalizedProfile;
    try {
      profile = mapClaims({ ...claims }, connection);
    } catch (e) {
      if (e instanceof IdpClaimError) throw new IdpLoginError(e.message, 'claims');
      throw e;
    }
    return {
      profile,
      connection,
      tokens: toTokenSet(response, this.clock.now()),
      returnTo: state.r,
    };
  }
}

export { OAuthProtocolError };

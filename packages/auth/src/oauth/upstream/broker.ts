import {
  type Keyring,
  MS,
  newId,
  redisKeys,
  TtlCache,
  type UpstreamAuthSpec,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import * as client from 'openid-client';
import { z } from 'zod';
import {
  CIMD_REFUSAL_ERRORS,
  CIMD_REJECTED_TTL_S,
  DISCOVERY_CACHE_MAX,
  DISCOVERY_TTL_MS,
  STEP_UP_TTL_S,
  SWEEP_WINDOW_MS,
  UPSTREAM_REFRESH_WINDOW_S,
} from '../constants';
import {
  buildConfiguration,
  checkIssuerParameter,
  type OAuthHttpOptions,
  OAuthProtocolError,
  toProtocolError,
} from '../http';
import { noopMetrics, type OAuthMetrics, type RefreshOutcome, withRefreshSpan } from '../metrics';
import {
  type Clock,
  type FetchFn,
  type PrincipalType,
  type RedisLike,
  type SecretRef,
  type SecretStore,
  type SigningKeySource,
  systemClock,
  type UpstreamClientStore,
  type UpstreamTokenRow,
  type UpstreamTokenStore,
} from '../ports';
import { createSafeFetch, type OutboundPolicy } from '../safe-fetch';
import { connectUrl, upstreamCallbackUrl } from '../urls';
import { resolveClientIdentity, type UpstreamOAuthClientSpec } from './client-identity';
import { discoverUpstream, parseChallengeParams, type UpstreamDiscovery } from './discovery';
import { openUpstreamState, sealUpstreamState } from './state';

export type UpstreamPrincipal = { type: PrincipalType; id: string };

export type OAuthAuthSpec = Extract<UpstreamAuthSpec, { mode: 'oauth' }>;

/** What the broker needs to know about an installation. */
export type OAuthInstallation = {
  id: string;
  name: string;
  kind: 'remote' | 'package';
  /** The upstream MCP URL, with template variables already resolved. */
  upstreamUrl: string;
  auth: OAuthAuthSpec;
};

export interface InstallationLookup {
  get(installationId: string): Promise<OAuthInstallation | null>;
}

export type ConnectPageModel = {
  installationId: string;
  installationName: string;
  /** Names the upstream authorization server so the user consents before the redirect (9.6). */
  authorizationServerHost: string;
  authorizationServerIssuer: string;
  scopes: string[];
  requiresClick: true;
};

export type UpstreamTokenStatusView = {
  status: UpstreamTokenRow['status'];
  scopes: string[];
  expiresAt: Date | null;
  issuer: string;
};

export type UpstreamAccessToken = {
  accessToken: string;
  expiresAt: number | null;
  scopes: string[];
};

export type BrokerDeps = {
  host: string;
  orgName: string;
  stateKeyring: Keyring;
  secrets: SecretStore;
  clients: UpstreamClientStore;
  tokens: UpstreamTokenStore;
  signingKeys: SigningKeySource;
  redis: RedisLike;
  installations: InstallationLookup;
  /** Raw fetch; the broker wraps it with the SSRF guard. */
  fetch: FetchFn;
  outbound?: OutboundPolicy;
  allowInsecureHttp?: boolean;
  clock?: Clock;
  metrics?: OAuthMetrics;
  /** Id source for the sealed-state nonce; default UUIDv7. */
  newId?: () => string;
};

const tokenBundle = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
});
type TokenBundle = z.infer<typeof tokenBundle>;

/** HTTP statuses of a token-endpoint refusal that mean the grant is gone; every other failure may pass. */
const PERMANENT_REFRESH_STATUSES: readonly number[] = [400, 401];

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const stepUpScopes = z.array(z.string());

/** The caller-facing token for a stored bundle and the row that describes it. */
const toAccessToken = (
  bundle: TokenBundle,
  row: { expiresAt: Date | null; scopes: readonly string[] },
): UpstreamAccessToken => ({
  accessToken: bundle.accessToken,
  expiresAt: row.expiresAt?.getTime() ?? null,
  scopes: [...row.scopes],
});

export const unionScopes = (...lists: (readonly string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => (l ? [...l] : []))),
];

/** Per-user upstream OAuth (9.6): discovery, authorization with PKCE, callback, storage, refresh. */
export class UpstreamOAuthBroker {
  private readonly clock: Clock;
  private readonly metrics: OAuthMetrics;
  private readonly safeFetch: FetchFn;
  private readonly http: OAuthHttpOptions;
  private readonly discoveries: TtlCache<string, UpstreamDiscovery>;
  private readonly newId: () => string;
  private readonly inflight = new Map<string, Promise<UpstreamAccessToken | null>>();

  constructor(private readonly deps: BrokerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.metrics = deps.metrics ?? noopMetrics;
    this.newId = deps.newId ?? (() => newId(this.clock.now()));
    this.discoveries = new TtlCache({
      ttlMs: DISCOVERY_TTL_MS,
      max: DISCOVERY_CACHE_MAX,
      clock: this.clock,
    });
    this.safeFetch = createSafeFetch(deps.fetch, deps.outbound ?? {});
    this.http = {
      fetch: this.safeFetch,
      ...(deps.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    };
  }

  /** Exposes the SSRF-guarded fetch and discovery cache to the IdP-minted credential modes. */
  async discover(upstreamUrl: string): Promise<UpstreamDiscovery> {
    const cached = this.discoveries.get(upstreamUrl);
    if (cached) return cached;
    const value = await discoverUpstream({ mcpUrl: upstreamUrl, fetch: this.safeFetch });
    this.discoveries.set(upstreamUrl, value);
    return value;
  }

  private tokenRef(principalId: string, installationId: string): SecretRef {
    return { scope: 'user', ownerId: principalId, name: `upstream-token:${installationId}` };
  }

  /** Discovery plus the client configuration at the upstream AS (also used by the IdP-minted modes). */
  async clientFor(
    upstreamUrl: string,
    spec: UpstreamOAuthClientSpec = { registration: 'auto' },
  ): Promise<{ discovery: UpstreamDiscovery; config: client.Configuration }> {
    const discovery = await this.discover(upstreamUrl);
    return { discovery, config: await this.configurationFor(spec, discovery) };
  }

  private configuration(installation: OAuthInstallation, discovery: UpstreamDiscovery) {
    return this.configurationFor(installation.auth.client, discovery);
  }

  private async configurationFor(spec: UpstreamOAuthClientSpec, discovery: UpstreamDiscovery) {
    const identity = await this.identityFor(spec, discovery);
    return buildConfiguration(discovery.metadata, identity.clientId, identity.auth, this.http);
  }

  private async identityFor(spec: UpstreamOAuthClientSpec, discovery: UpstreamDiscovery) {
    const cimdRejected =
      spec.registration === 'auto' &&
      (await this.deps.redis.get(redisKeys.upstreamCimdRejected(discovery.issuer))) !== null;
    return resolveClientIdentity(
      {
        host: this.deps.host,
        orgName: this.deps.orgName,
        clients: this.deps.clients,
        secrets: this.deps.secrets,
        signingKeys: this.deps.signingKeys,
        fetch: this.safeFetch,
        clock: this.clock,
        cimdRejected,
      },
      spec,
      discovery,
    );
  }

  /**
   * `auto` registration chose CIMD and the AS refused the identity (the failure only shows at the authorization
   * redirect or the code exchange). Remember it per issuer so the user's retry registers dynamically instead.
   */
  private async noteCimdRefusal(
    installation: OAuthInstallation,
    discovery: UpstreamDiscovery,
    error: string | undefined,
  ): Promise<void> {
    if (!error || !CIMD_REFUSAL_ERRORS.includes(error)) return;
    if (installation.auth.client.registration !== 'auto') return;
    const identity = await this.identityFor(installation.auth.client, discovery);
    if (identity.registration !== 'cimd') return;
    await this.deps.redis.set(
      redisKeys.upstreamCimdRejected(discovery.issuer),
      '1',
      CIMD_REJECTED_TTL_S,
    );
  }

  private async pendingStepUp(principalId: string, installationId: string): Promise<string[]> {
    const raw = await this.deps.redis.get(redisKeys.upstreamStepUp(principalId, installationId));
    if (!raw) return [];
    const parsed = stepUpScopes.safeParse(parseJson(raw));
    return parsed.success ? parsed.data : [];
  }

  /** The page content for `/connect/<installationId>`: names the AS host and requires a click (9.6). */
  async connectPage(installation: OAuthInstallation): Promise<ConnectPageModel> {
    const discovery = await this.discover(installation.upstreamUrl);
    return {
      installationId: installation.id,
      installationName: installation.name,
      authorizationServerHost: new URL(discovery.issuer).host,
      authorizationServerIssuer: discovery.issuer,
      scopes: unionScopes(installation.auth.scopes),
      requiresClick: true,
    };
  }

  /** After the click: the authorization URL with PKCE S256, sealed `state` and RFC 8707 `resource`. */
  async startAuthorization(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
  ): Promise<{ authorizationUrl: string }> {
    if (principal.type === 'service') {
      throw new OAuthProtocolError('service accounts cannot use interactive upstream OAuth');
    }
    const discovery = await this.discover(installation.upstreamUrl);
    const config = await this.configuration(installation, discovery);
    const existing = await this.deps.tokens.get(principal.id, installation.id);
    const scopes = unionScopes(
      installation.auth.scopes,
      existing?.issuer === discovery.issuer ? existing.scopes : [],
      await this.pendingStepUp(principal.id, installation.id),
    );
    const verifier = client.randomPKCECodeVerifier();
    const state = sealUpstreamState(
      {
        principalId: principal.id,
        principalType: principal.type,
        installationId: installation.id,
        nonce: this.newId(),
        codeVerifier: verifier,
        issuer: discovery.issuer,
        scopes,
      },
      this.deps.stateKeyring,
      this.clock,
    );
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: upstreamCallbackUrl(this.deps.host),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      resource: discovery.resource,
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    });
    return { authorizationUrl: url.href };
  }

  /**
   * `/oauth/upstream/callback`: verifies the sealed state (user, expiry, single use), the RFC 9207 `iss`,
   * redeems the code and stores the tokens envelope-encrypted. `principal` is the signed-in session.
   */
  async completeAuthorization(
    principal: UpstreamPrincipal,
    query: string,
  ): Promise<{ installationId: string; scopes: string[] }> {
    const params = new URLSearchParams(query);
    const stateToken = params.get('state');
    if (!stateToken) throw new OAuthProtocolError('callback is missing state');
    const state = await openUpstreamState(stateToken, this.deps.stateKeyring, {
      principalId: principal.id,
      redis: this.deps.redis,
      clock: this.clock,
    });
    const installation = await this.deps.installations.get(state.installationId);
    if (!installation) throw new OAuthProtocolError('installation no longer exists');
    const discovery = await this.discover(installation.upstreamUrl);
    const error = params.get('error');
    if (error) {
      await this.noteCimdRefusal(installation, discovery, error);
      const description = params.get('error_description');
      throw new OAuthProtocolError(`upstream returned ${error}`, {
        error,
        ...(description ? { description } : {}),
      });
    }
    if (discovery.issuer !== state.issuer) {
      throw new OAuthProtocolError('upstream authorization server changed during the flow');
    }
    checkIssuerParameter(params, state.issuer, discovery.issParameterSupported);
    const config = await this.configuration(installation, discovery);
    const callback = new URL(upstreamCallbackUrl(this.deps.host));
    callback.search = params.toString();
    let response: client.TokenEndpointResponse;
    try {
      response = await client.authorizationCodeGrant(
        config,
        callback,
        { pkceCodeVerifier: state.codeVerifier, expectedState: stateToken },
        { resource: discovery.resource },
      );
    } catch (e) {
      const failure = toProtocolError(e, 'upstream code exchange failed');
      await this.noteCimdRefusal(installation, discovery, failure.error);
      throw failure;
    }
    const scopes = response.scope ? response.scope.split(' ') : state.scopes;
    await this.store(principal, installation.id, discovery.issuer, response, scopes);
    await this.deps.redis.del(redisKeys.upstreamStepUp(principal.id, installation.id));
    return { installationId: installation.id, scopes };
  }

  private async store(
    principal: UpstreamPrincipal,
    installationId: string,
    issuer: string,
    response: client.TokenEndpointResponse,
    scopes: string[],
    previous?: TokenBundle,
  ): Promise<Date | null> {
    const bundle: TokenBundle = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
    };
    const { id } = await this.deps.secrets.put(
      this.tokenRef(principal.id, installationId),
      JSON.stringify(bundle),
    );
    const expiresAt =
      typeof response.expires_in === 'number'
        ? new Date(this.clock.now() + response.expires_in * MS.SECOND)
        : null;
    await this.deps.tokens.put({
      principalType: principal.type,
      principalId: principal.id,
      installationId,
      issuer,
      secretId: id,
      scopes,
      expiresAt,
      status: 'valid',
      updatedAt: new Date(this.clock.now()),
    });
    return expiresAt;
  }

  private async loadBundle(
    principal: UpstreamPrincipal,
    installationId: string,
  ): Promise<TokenBundle | null> {
    const raw = await this.deps.secrets.reveal(this.tokenRef(principal.id, installationId));
    if (raw === null) return null;
    const parsed = tokenBundle.safeParse(parseJson(raw));
    return parsed.success ? parsed.data : null;
  }

  /** Status only: never the tokens (9.6). */
  async status(
    principalId: string,
    installationId: string,
  ): Promise<UpstreamTokenStatusView | null> {
    const row = await this.deps.tokens.get(principalId, installationId);
    return row
      ? {
          status: row.status,
          scopes: [...row.scopes],
          expiresAt: row.expiresAt,
          issuer: row.issuer,
        }
      : null;
  }

  /**
   * The access token for a call, refreshed when fewer than 5 minutes remain (single flight per principal
   * and installation). Null means the user must (re)connect.
   */
  async accessToken(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
  ): Promise<UpstreamAccessToken | null> {
    const row = await this.deps.tokens.get(principal.id, installation.id);
    if (!row || row.status === 'reconnect_required') return null;
    const remainingMs = row.expiresAt
      ? row.expiresAt.getTime() - this.clock.now()
      : Number.POSITIVE_INFINITY;
    if (remainingMs > UPSTREAM_REFRESH_WINDOW_S * MS.SECOND) {
      const bundle = await this.loadBundle(principal, installation.id);
      return bundle ? toAccessToken(bundle, row) : null;
    }
    return this.refresh(principal, installation);
  }

  /** Refreshes now (also used by the daily sweep); single flight per (principal, installation). */
  refresh(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
  ): Promise<UpstreamAccessToken | null> {
    const key = `${principal.id}:${installation.id}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = withRefreshSpan(
      { 'bastion.principal.type': principal.type, 'bastion.installation.id': installation.id },
      () => this.doRefresh(principal, installation),
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async markReconnect(row: UpstreamTokenRow): Promise<null> {
    await this.deps.tokens.put({
      ...row,
      status: 'reconnect_required',
      updatedAt: new Date(this.clock.now()),
    });
    this.metrics.recordRefresh('reconnect_required');
    return null;
  }

  /**
   * The upstream refused our refresh token. Another replica may have rotated it a moment ago (single-use refresh
   * tokens), so re-read the row: when it changed and is still usable, that is the answer, not a reconnect.
   */
  private async reconnectUnlessRefreshedElsewhere(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
    row: UpstreamTokenRow,
  ): Promise<UpstreamAccessToken | null> {
    const latest = await this.deps.tokens.get(principal.id, installation.id);
    if (!latest) return null;
    const changed =
      latest.secretId !== row.secretId || latest.updatedAt.getTime() !== row.updatedAt.getTime();
    if (changed && latest.status === 'valid') {
      const bundle = await this.loadBundle(principal, installation.id);
      if (bundle) return toAccessToken(bundle, latest);
    }
    return this.markReconnect(latest);
  }

  private async doRefresh(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
  ): Promise<UpstreamAccessToken | null> {
    const row = await this.deps.tokens.get(principal.id, installation.id);
    if (!row || row.status === 'reconnect_required') return null;
    const bundle = await this.loadBundle(principal, installation.id);
    if (!bundle?.refreshToken) return this.markReconnect(row);
    let outcome: RefreshOutcome = 'failure';
    try {
      const discovery = await this.discover(installation.upstreamUrl);
      if (discovery.issuer !== row.issuer) return await this.markReconnect(row);
      const config = await this.configuration(installation, discovery);
      const response = await client.refreshTokenGrant(config, bundle.refreshToken, {
        resource: discovery.resource,
      });
      const scopes = response.scope ? response.scope.split(' ') : [...row.scopes];
      const expiresAt = await this.store(
        principal,
        installation.id,
        row.issuer,
        response,
        scopes,
        bundle,
      );
      outcome = 'success';
      this.metrics.recordRefresh(outcome);
      return toAccessToken(
        { ...bundle, accessToken: response.access_token },
        { expiresAt, scopes },
      );
    } catch (error) {
      const protocol = toProtocolError(error, 'upstream refresh failed');
      if (protocol.status !== undefined && PERMANENT_REFRESH_STATUSES.includes(protocol.status)) {
        return this.reconnectUnlessRefreshedElsewhere(principal, installation, row);
      }
      this.metrics.recordRefresh('failure');
      // Transient failure: a token that is still valid keeps working.
      if (row.expiresAt === null || row.expiresAt.getTime() > this.clock.now()) {
        return toAccessToken(bundle, row);
      }
      throw new UpstreamUnavailableError(
        'upstream token refresh failed',
        { installation: installation.id },
        error,
      );
    }
  }

  /** Daily scheduler sweep (9.6): refreshes tokens that expire within the next day. */
  async sweep(): Promise<{ refreshed: number; reconnectRequired: number; failed: number }> {
    const result = { refreshed: 0, reconnectRequired: 0, failed: 0 };
    const rows = await this.deps.tokens.listExpiringBefore(
      new Date(this.clock.now() + SWEEP_WINDOW_MS),
    );
    for (const row of rows) {
      const installation = await this.deps.installations.get(row.installationId);
      if (!installation) continue;
      try {
        const token = await this.refresh(
          { type: row.principalType, id: row.principalId },
          installation,
        );
        if (token) result.refreshed += 1;
        else result.reconnectRequired += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  /** Step-up (9.6): records the union of current and required scopes and returns the connect URL. */
  async requestStepUp(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
    required: readonly string[],
  ): Promise<{ connectUrl: string; scopes: string[] }> {
    const row = await this.deps.tokens.get(principal.id, installation.id);
    const scopes = unionScopes(installation.auth.scopes, row?.scopes, required);
    await this.deps.redis.set(
      redisKeys.upstreamStepUp(principal.id, installation.id),
      JSON.stringify(scopes),
      STEP_UP_TTL_S,
    );
    return { connectUrl: connectUrl(this.deps.host, installation.id), scopes };
  }

  /** Reads an upstream `403 WWW-Authenticate` challenge; `insufficient_scope` triggers a step-up. */
  async handleChallenge(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation,
    wwwAuthenticate: string | null,
  ): Promise<{ connectUrl: string; scopes: string[] } | null> {
    const params = parseChallengeParams(wwwAuthenticate);
    if (params.error !== 'insufficient_scope') return null;
    const required = params.scope ? params.scope.split(/\s+/).filter(Boolean) : [];
    return this.requestStepUp(principal, installation, required);
  }

  /** Revokes (RFC 7009, where supported) and deletes the stored tokens (deactivation, 9.1). */
  async disconnect(
    principal: UpstreamPrincipal,
    installation: OAuthInstallation | null,
    installationId: string,
  ): Promise<void> {
    const bundle = await this.loadBundle(principal, installationId);
    if (bundle && installation) {
      try {
        const discovery = await this.discover(installation.upstreamUrl);
        if (discovery.revocationEndpoint) {
          const config = await this.configuration(installation, discovery);
          const tokens: [string, string][] = [
            ...(bundle.refreshToken
              ? [[bundle.refreshToken, 'refresh_token'] as [string, string]]
              : []),
            [bundle.accessToken, 'access_token'],
          ];
          for (const [token, hint] of tokens) {
            // One failed revocation must not skip the other token.
            await client
              .tokenRevocation(config, token, { token_type_hint: hint })
              .catch(() => undefined);
          }
        }
      } catch {
        // Best effort: the local copy is deleted regardless.
      }
    }
    await this.deps.secrets.delete(this.tokenRef(principal.id, installationId));
    await this.deps.tokens.delete(principal.id, installationId);
  }

  /** Deactivation of a principal: revoke and delete every upstream token. */
  async disconnectAll(principal: UpstreamPrincipal): Promise<number> {
    const rows = await this.deps.tokens.listByPrincipal(principal.id);
    for (const row of rows) {
      await this.disconnect(
        principal,
        await this.deps.installations.get(row.installationId),
        row.installationId,
      );
    }
    return rows.length;
  }
}

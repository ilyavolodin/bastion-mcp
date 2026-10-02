import { randomUUID } from 'node:crypto';
import { type Keyring, type UpstreamAuthSpec, UpstreamUnavailableError } from '@bastion-mcp/core';
import * as client from 'openid-client';
import { z } from 'zod';
import { UPSTREAM_REFRESH_WINDOW_S } from '../constants';
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
};

const tokenBundle = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
});
type TokenBundle = z.infer<typeof tokenBundle>;

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const STEP_UP_TTL_S = 60 * 60;

export const unionScopes = (...lists: (readonly string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => (l ? [...l] : []))),
];

/** Per-user upstream OAuth (9.6): discovery, authorization with PKCE, callback, storage, refresh. */
export class UpstreamOAuthBroker {
  private readonly clock: Clock;
  private readonly metrics: OAuthMetrics;
  private readonly safeFetch: FetchFn;
  private readonly http: OAuthHttpOptions;
  private readonly discoveries = new Map<string, { at: number; value: UpstreamDiscovery }>();
  private readonly inflight = new Map<string, Promise<UpstreamAccessToken | null>>();

  constructor(private readonly deps: BrokerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.metrics = deps.metrics ?? noopMetrics;
    this.safeFetch = createSafeFetch(deps.fetch, deps.outbound ?? {});
    this.http = {
      fetch: this.safeFetch,
      ...(deps.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    };
  }

  /** Exposes the SSRF-guarded fetch and discovery cache to the IdP-minted credential modes. */
  async discover(upstreamUrl: string): Promise<UpstreamDiscovery> {
    const cached = this.discoveries.get(upstreamUrl);
    if (cached && this.clock.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;
    const value = await discoverUpstream({ mcpUrl: upstreamUrl, fetch: this.safeFetch });
    this.discoveries.set(upstreamUrl, { at: this.clock.now(), value });
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
    const identity = await resolveClientIdentity(
      {
        host: this.deps.host,
        orgName: this.deps.orgName,
        clients: this.deps.clients,
        secrets: this.deps.secrets,
        signingKeys: this.deps.signingKeys,
        fetch: this.safeFetch,
        clock: this.clock,
      },
      spec,
      discovery,
    );
    return buildConfiguration(
      discovery.metadata as client.ServerMetadata,
      identity.clientId,
      identity.auth,
      this.http,
    );
  }

  private stepUpKey = (principalId: string, installationId: string) =>
    `ups:stepup:${principalId}:${installationId}`;

  private async pendingStepUp(principalId: string, installationId: string): Promise<string[]> {
    const raw = await this.deps.redis.get(this.stepUpKey(principalId, installationId));
    if (!raw) return [];
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
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
        nonce: randomUUID(),
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
    const error = params.get('error');
    if (error) {
      throw new OAuthProtocolError(`upstream returned ${error}`, {
        error,
        ...(params.get('error_description')
          ? { description: params.get('error_description') as string }
          : {}),
      });
    }
    const discovery = await this.discover(installation.upstreamUrl);
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
      throw toProtocolError(e, 'upstream code exchange failed');
    }
    const scopes = response.scope ? response.scope.split(' ') : state.scopes;
    await this.store(principal, installation.id, discovery.issuer, response, scopes);
    await this.deps.redis.del(this.stepUpKey(principal.id, installation.id));
    return { installationId: installation.id, scopes };
  }

  private async store(
    principal: UpstreamPrincipal,
    installationId: string,
    issuer: string,
    response: client.TokenEndpointResponse,
    scopes: string[],
    previous?: TokenBundle,
  ): Promise<void> {
    const bundle: TokenBundle = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? previous?.refreshToken ?? null,
    };
    const { id } = await this.deps.secrets.put(
      this.tokenRef(principal.id, installationId),
      JSON.stringify(bundle),
    );
    await this.deps.tokens.put({
      principalType: principal.type,
      principalId: principal.id,
      installationId,
      issuer,
      secretId: id,
      scopes,
      expiresAt:
        typeof response.expires_in === 'number'
          ? new Date(this.clock.now() + response.expires_in * 1000)
          : null,
      status: 'valid',
      updatedAt: new Date(this.clock.now()),
    });
  }

  private async loadBundle(
    principal: UpstreamPrincipal,
    installationId: string,
  ): Promise<TokenBundle | null> {
    const raw = await this.deps.secrets.reveal(this.tokenRef(principal.id, installationId));
    return raw === null ? null : tokenBundle.parse(JSON.parse(raw));
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
    if (remainingMs > UPSTREAM_REFRESH_WINDOW_S * 1000) {
      const bundle = await this.loadBundle(principal, installation.id);
      return bundle
        ? {
            accessToken: bundle.accessToken,
            expiresAt: row.expiresAt?.getTime() ?? null,
            scopes: [...row.scopes],
          }
        : null;
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
      await this.store(principal, installation.id, row.issuer, response, scopes, bundle);
      outcome = 'success';
      this.metrics.recordRefresh(outcome);
      const fresh = await this.deps.tokens.get(principal.id, installation.id);
      return {
        accessToken: response.access_token,
        expiresAt: fresh?.expiresAt?.getTime() ?? null,
        scopes,
      };
    } catch (error) {
      const protocol = toProtocolError(error, 'upstream refresh failed');
      if (protocol.status !== undefined && protocol.status >= 400 && protocol.status < 500) {
        return this.markReconnect(row);
      }
      this.metrics.recordRefresh('failure');
      // Transient failure: a token that is still valid keeps working.
      if (row.expiresAt === null || row.expiresAt.getTime() > this.clock.now()) {
        return {
          accessToken: bundle.accessToken,
          expiresAt: row.expiresAt?.getTime() ?? null,
          scopes: [...row.scopes],
        };
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
      new Date(this.clock.now() + 24 * 60 * 60 * 1000),
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
      this.stepUpKey(principal.id, installation.id),
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
          if (bundle.refreshToken)
            await client.tokenRevocation(config, bundle.refreshToken, {
              token_type_hint: 'refresh_token',
            });
          await client.tokenRevocation(config, bundle.accessToken, {
            token_type_hint: 'access_token',
          });
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

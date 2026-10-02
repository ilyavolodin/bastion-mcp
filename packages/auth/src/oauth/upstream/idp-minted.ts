import {
  PolicyDeniedError,
  UpstreamAuthRequiredError,
  type UpstreamAuthSpec,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import * as client from 'openid-client';
import {
  ACCESS_TOKEN_TYPE,
  ENTERPRISE_TOKEN_SKEW_S,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from '../constants';
import { toProtocolError } from '../http';
import type { IdpClients, IdpTokenSet } from '../idp/login';
import { IdpRefreshError, type IdpTokenVault, refreshIdpTokens } from '../idp/tokens';
import { type Clock, type SecretStore, systemClock } from '../ports';
import { connectUrl } from '../urls';
import type { UpstreamOAuthBroker, UpstreamPrincipal } from './broker';
import { OAuthConfigError } from './injection';

export type EnterpriseManagedSpec = Extract<UpstreamAuthSpec, { mode: 'enterpriseManaged' }>;
export type TokenExchangeSpec = Extract<UpstreamAuthSpec, { mode: 'tokenExchange' }>;
export type IdpMintedSpec = EnterpriseManagedSpec | TokenExchangeSpec;

export type MintedToken = { accessToken: string; expiresAt: number };

export type IdpMintedDeps = {
  host: string;
  idpClients: IdpClients;
  vault: IdpTokenVault;
  broker: UpstreamOAuthBroker;
  secrets: SecretStore;
  clock?: Clock;
};

export type MintTarget = { id: string; upstreamUrl: string };

/**
 * IdP-minted upstream tokens (9.7): `enterpriseManaged` (RFC 8693 to an ID-JAG, then the RFC 7523
 * jwt-bearer grant at the upstream AS) and `tokenExchange` (`rfc8693` and `entra-obo`).
 * Access tokens are cached in memory until 60 s before expiry; refusals cache nothing.
 */
export class IdpMintedTokens {
  private readonly clock: Clock;
  private readonly cache = new Map<string, MintedToken>();

  constructor(private readonly deps: IdpMintedDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  private needsAuth(target: MintTarget, message: string): UpstreamAuthRequiredError {
    return new UpstreamAuthRequiredError(message, {
      installation: target.id,
      connectUrl: connectUrl(this.deps.host, target.id),
    });
  }

  /** IdP refusals (policy denies the user) surface as -32010 with the IdP's own description. */
  private refusal(error: unknown, target: MintTarget, context: string): never {
    const protocol = toProtocolError(error, context);
    if (protocol.status !== undefined && protocol.status >= 400 && protocol.status < 500) {
      throw new PolicyDeniedError(
        protocol.description ?? protocol.error ?? 'refused by the identity provider',
        {
          reason: protocol.error ?? 'idp_refused',
        },
      );
    }
    throw new UpstreamUnavailableError(
      `${context}: identity provider unavailable`,
      { installation: target.id },
      error,
    );
  }

  private async idpSession(
    principal: UpstreamPrincipal,
    target: MintTarget,
    connectionId: string,
    forceRefresh: boolean,
  ): Promise<IdpTokenSet> {
    try {
      return await refreshIdpTokens({
        clients: this.deps.idpClients,
        vault: this.deps.vault,
        clock: this.clock,
        userId: principal.id,
        connectionId,
        forceRefresh,
      });
    } catch (error) {
      if (error instanceof IdpRefreshError) {
        if (error.kind === 'unavailable') {
          throw new UpstreamUnavailableError(
            'identity provider unavailable',
            { installation: target.id },
            error,
          );
        }
        throw this.needsAuth(target, 'sign in again to refresh your identity provider session');
      }
      throw error;
    }
  }

  async mint(
    principal: UpstreamPrincipal,
    target: MintTarget,
    spec: IdpMintedSpec,
  ): Promise<MintedToken> {
    const scopes = spec.scopes ?? [];
    const key = [
      spec.mode,
      principal.id,
      target.id,
      spec.mode === 'tokenExchange' ? `${spec.flavor}|${spec.audience}` : '',
      scopes.join(' '),
    ].join('|');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.clock.now() > ENTERPRISE_TOKEN_SKEW_S * 1000)
      return cached;
    const minted =
      spec.mode === 'enterpriseManaged'
        ? await this.mintEnterpriseManaged(principal, target, spec)
        : await this.mintExchange(principal, target, spec);
    this.cache.set(key, minted);
    return minted;
  }

  private async idpConfig(
    connection: Parameters<IdpClients['configuration']>[0],
    target: MintTarget,
  ): Promise<client.Configuration> {
    try {
      return await this.deps.idpClients.configuration(connection);
    } catch (error) {
      throw new UpstreamUnavailableError(
        'identity provider discovery failed',
        { installation: target.id },
        error,
      );
    }
  }

  private async connection(connectionId: string, needsRefreshToken: boolean) {
    let connection: Awaited<ReturnType<IdpClients['connection']>>;
    try {
      connection = await this.deps.idpClients.connection(connectionId);
    } catch {
      throw new OAuthConfigError('the IdP connection of this installation is missing or disabled');
    }
    if (needsRefreshToken && !connection.storeRefreshToken) {
      throw new OAuthConfigError(
        'this credential mode requires storeRefreshToken on the IdP connection (9.7)',
      );
    }
    return connection;
  }

  private async mintEnterpriseManaged(
    principal: UpstreamPrincipal,
    target: MintTarget,
    spec: EnterpriseManagedSpec,
  ): Promise<MintedToken> {
    if (principal.type === 'service') {
      throw new PolicyDeniedError('service accounts cannot use enterprise-managed authorization');
    }
    const connection = await this.connection(spec.idpConnectionId, true);
    const idp = await this.idpSession(principal, target, connection.id, true);
    // A refresh that returns no ID token cannot be exchanged: -32015 (9.7).
    if (!idp.idToken)
      throw this.needsAuth(target, 'the identity provider returned no ID token; sign in again');
    const { discovery, config: upstream } = await this.deps.broker.clientFor(target.upstreamUrl);
    if (
      discovery.grantTypesSupported &&
      !discovery.grantTypesSupported.includes(JWT_BEARER_GRANT)
    ) {
      throw new OAuthConfigError(
        'the upstream authorization server does not support the jwt-bearer grant',
      );
    }
    const idpConfig = await this.idpConfig(connection, target);
    let jag: string;
    try {
      const exchanged = await client.genericGrantRequest(idpConfig, TOKEN_EXCHANGE_GRANT, {
        requested_token_type: ID_JAG_TOKEN_TYPE,
        subject_token: idp.idToken,
        subject_token_type: ID_TOKEN_TYPE,
        audience: discovery.issuer,
        resource: discovery.resource,
        ...(spec.scopes && spec.scopes.length > 0 ? { scope: spec.scopes.join(' ') } : {}),
      });
      jag = exchanged.access_token;
    } catch (error) {
      this.refusal(error, target, 'ID-JAG exchange failed');
    }
    try {
      const response = await client.genericGrantRequest(upstream, JWT_BEARER_GRANT, {
        assertion: jag,
        ...(spec.scopes && spec.scopes.length > 0 ? { scope: spec.scopes.join(' ') } : {}),
      });
      return this.minted(response);
    } catch (error) {
      return this.refusal(error, target, 'upstream refused the ID-JAG');
    }
  }

  private async subjectToken(
    principal: UpstreamPrincipal,
    target: MintTarget,
    connectionId: string,
  ): Promise<string> {
    if (principal.type === 'service') {
      // Service accounts have no IdP session: only a configured subject token (9.3).
      const configured = await this.deps.secrets.reveal({
        scope: 'user',
        ownerId: principal.id,
        name: 'subject-token',
      });
      if (!configured)
        throw this.needsAuth(target, 'the service account has no subject token configured');
      return configured;
    }
    await this.connection(connectionId, true);
    const tokens = await this.idpSession(principal, target, connectionId, false);
    return tokens.accessToken;
  }

  private async mintExchange(
    principal: UpstreamPrincipal,
    target: MintTarget,
    spec: TokenExchangeSpec,
  ): Promise<MintedToken> {
    const connection = await this.deps.idpClients.connection(spec.idpConnectionId).catch(() => {
      throw new OAuthConfigError('the IdP connection of this installation is missing or disabled');
    });
    const subjectToken = await this.subjectToken(principal, target, connection.id);
    const idpConfig = await this.idpConfig(connection, target);
    try {
      if (spec.flavor === 'entra-obo') {
        const scope = spec.audience.endsWith('/.default')
          ? spec.audience
          : `${spec.audience.replace(/\/$/, '')}/.default`;
        return this.minted(
          await client.genericGrantRequest(idpConfig, JWT_BEARER_GRANT, {
            assertion: subjectToken,
            requested_token_use: 'on_behalf_of',
            scope,
          }),
        );
      }
      return this.minted(
        await client.genericGrantRequest(idpConfig, TOKEN_EXCHANGE_GRANT, {
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          audience: spec.audience,
          ...(spec.scopes && spec.scopes.length > 0 ? { scope: spec.scopes.join(' ') } : {}),
        }),
      );
    } catch (error) {
      return this.refusal(error, target, 'token exchange failed');
    }
  }

  private minted(response: client.TokenEndpointResponse): MintedToken {
    const seconds = typeof response.expires_in === 'number' ? response.expires_in : 300;
    return { accessToken: response.access_token, expiresAt: this.clock.now() + seconds * 1000 };
  }
}

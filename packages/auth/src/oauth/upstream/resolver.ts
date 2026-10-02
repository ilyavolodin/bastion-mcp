import {
  canonicalJson,
  extractReferences,
  PolicyDeniedError,
  type ServerSpec,
  sha256Hex,
  type TemplateContext,
  UpstreamAuthRequiredError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import { OAuthProtocolError } from '../http';
import { connectUrl } from '../urls';
import type { UpstreamOAuthBroker, UpstreamPrincipal } from './broker';
import { UpstreamClientError } from './client-identity';
import { UpstreamDiscoveryError } from './discovery';
import type { IdpMintedTokens } from './idp-minted';
import { buildInjections, OAuthConfigError, type ResolvedInjection } from './injection';
import { UpstreamStateError } from './state';

/** Secrets for `orgSecret` and `userSecret` modes (backed by `SecretVault`, 14). */
export interface SecretResolver {
  resolve(ref: {
    scope: 'org' | 'user';
    ownerId: string | null;
    name: string;
  }): Promise<{ value: string; version: number } | null>;
}

export type ResolverInstallation = {
  id: string;
  name: string;
  /** The upstream MCP URL after variable substitution; defaults to `spec.url` for remote servers. */
  upstreamUrl?: string;
  /** Values for `{{var.*}}`, `{{user.*}}` and `{{sandbox.*}}` references. */
  templateContext?: Pick<TemplateContext, 'var' | 'user' | 'sandbox'>;
};

export type ResolvedCredential = {
  injections: ResolvedInjection[];
  /** Identity of the credential for Redis cache keys (16.3): never derived from the secret itself. */
  credentialHash: string;
  /** Expiry of an injected OAuth token (epoch ms), used by the package restart decision (9.6). */
  expiresAt: number | null;
};

export type ResolverDeps = {
  host: string;
  secrets: SecretResolver;
  broker: UpstreamOAuthBroker;
  minted: IdpMintedTokens;
};

const hashOf = (identity: unknown): string => sha256Hex(canonicalJson(identity)).slice(0, 32);

const secretNames = (templates: readonly string[]): string[] => [
  ...new Set(
    templates.flatMap((t) =>
      extractReferences(t)
        .filter((ref) => ref.startsWith('secret.'))
        .map((ref) => ref.slice('secret.'.length)),
    ),
  ),
];

/**
 * The single entry point `mcp-upstream` calls to obtain what to inject for one call (9.5): all six modes.
 * Raises `UpstreamAuthRequiredError` (-32015) with a `connectUrl` when no usable credential exists.
 */
export class UpstreamCredentialResolver {
  constructor(private readonly deps: ResolverDeps) {}

  private needsAuth(
    installation: ResolverInstallation,
    message: string,
  ): UpstreamAuthRequiredError {
    return new UpstreamAuthRequiredError(message, {
      installation: installation.id,
      connectUrl: connectUrl(this.deps.host, installation.id),
    });
  }

  async resolve(
    principal: UpstreamPrincipal,
    installation: ResolverInstallation,
    spec: ServerSpec,
  ): Promise<ResolvedCredential> {
    const auth = spec.auth;
    const kind = spec.type;
    const base: TemplateContext = { ...installation.templateContext };
    switch (auth.mode) {
      case 'none':
        return { injections: [], credentialHash: hashOf({ mode: 'none' }), expiresAt: null };

      case 'orgSecret': {
        const names = secretNames((auth.inject ?? []).map((i) => i.value));
        const values: Record<string, string> = {};
        const versions: Record<string, number> = {};
        for (const name of names) {
          const found = await this.deps.secrets.resolve({ scope: 'org', ownerId: null, name });
          if (!found) throw new OAuthConfigError(`org secret "${name}" is not set`);
          values[name] = found.value;
          versions[name] = found.version;
        }
        return {
          injections: buildInjections({
            inject: auth.inject,
            kind,
            context: { ...base, secret: values },
          }),
          credentialHash: hashOf({ mode: 'orgSecret', versions }),
          expiresAt: null,
        };
      }

      case 'userSecret': {
        const values: Record<string, string> = {};
        const versions: Record<string, number> = {};
        for (const field of auth.fields) {
          // The install flow stores a person's value as `<installationId>.<field>` (11.4); a value saved under the
          // bare field name is the person's default for every installation (the author's own test values).
          const found =
            (await this.deps.secrets.resolve({
              scope: 'user',
              ownerId: principal.id,
              name: `${installation.id}.${field.name}`,
            })) ??
            (await this.deps.secrets.resolve({
              scope: 'user',
              ownerId: principal.id,
              name: field.name,
            }));
          if (!found)
            throw this.needsAuth(installation, `"${field.label}" is not set for this server`);
          values[field.name] = found.value;
          versions[field.name] = found.version;
        }
        return {
          injections: buildInjections({
            inject: auth.inject,
            kind,
            context: { ...base, secret: values },
          }),
          credentialHash: hashOf({ mode: 'userSecret', principal: principal.id, versions }),
          expiresAt: null,
        };
      }

      case 'oauth': {
        if (principal.type === 'service') {
          throw new PolicyDeniedError(
            'service accounts cannot use interactive upstream OAuth (9.3)',
          );
        }
        const upstreamUrl = this.upstreamUrl(installation, spec);
        const token = await this.guard(installation, () =>
          this.deps.broker.accessToken(principal, {
            id: installation.id,
            name: installation.name,
            kind,
            upstreamUrl,
            auth,
          }),
        );
        if (!token) throw this.needsAuth(installation, 'connect your account to use this server');
        const status = await this.deps.broker.status(principal.id, installation.id);
        return {
          injections: buildInjections({
            inject: auth.inject,
            kind,
            context: { ...base, oauth: { accessToken: token.accessToken } },
          }),
          credentialHash: hashOf({
            mode: 'oauth',
            principal: principal.id,
            issuer: status?.issuer ?? null,
          }),
          expiresAt: token.expiresAt,
        };
      }

      case 'enterpriseManaged':
      case 'tokenExchange': {
        const upstreamUrl =
          auth.mode === 'enterpriseManaged'
            ? this.upstreamUrl(installation, spec)
            : (installation.upstreamUrl ?? '');
        const minted = await this.guard(installation, () =>
          this.deps.minted.mint(principal, { id: installation.id, upstreamUrl }, auth),
        );
        const identity =
          auth.mode === 'enterpriseManaged'
            ? {
                mode: auth.mode,
                idp: auth.idpConnectionId,
                principal: principal.id,
                scopes: auth.scopes ?? [],
              }
            : {
                mode: auth.mode,
                flavor: auth.flavor,
                idp: auth.idpConnectionId,
                audience: auth.audience,
                principal: principal.id,
                scopes: auth.scopes ?? [],
              };
        return {
          injections: buildInjections({
            inject: auth.inject,
            kind,
            context: { ...base, oauth: { accessToken: minted.accessToken } },
          }),
          credentialHash: hashOf(identity),
          expiresAt: minted.expiresAt,
        };
      }
    }
  }

  private upstreamUrl(installation: ResolverInstallation, spec: ServerSpec): string {
    const url = installation.upstreamUrl ?? (spec.type === 'remote' ? spec.url : undefined);
    if (!url)
      throw new OAuthConfigError(
        'this credential mode needs the upstream MCP URL of the installation',
      );
    return url;
  }

  /** Discovery and protocol failures of the upstream are availability problems, not user errors. */
  private async guard<T>(installation: ResolverInstallation, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof UpstreamDiscoveryError ||
        error instanceof OAuthProtocolError ||
        error instanceof UpstreamClientError ||
        error instanceof UpstreamStateError
      ) {
        throw new UpstreamUnavailableError(error.message, { installation: installation.id }, error);
      }
      throw error;
    }
  }
}

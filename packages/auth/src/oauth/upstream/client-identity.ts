import type { UpstreamAuthSpec } from '@bastion-mcp/core';
import { buildJwks } from '@bastion-mcp/secrets';
import { importJWK } from 'jose';
import * as client from 'openid-client';
import { z } from 'zod';
import { OAuthProtocolError } from '../http';
import type {
  Clock,
  FetchFn,
  SecretStore,
  SigningKeySource,
  UpstreamClientRow,
  UpstreamClientStore,
} from '../ports';
import { systemClock } from '../ports';
import { upstreamCallbackUrl, upstreamClientMetadataUrl, upstreamJwksUrl } from '../urls';
import type { UpstreamDiscovery } from './discovery';

export type UpstreamOAuthClientSpec = Extract<UpstreamAuthSpec, { mode: 'oauth' }>['client'];

export class UpstreamClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamClientError';
  }
}

/** The document served at `/oauth/upstream/client-metadata.json` (9.6, CIMD). */
export const buildUpstreamClientMetadata = (input: { host: string; orgName: string }) => ({
  client_id: upstreamClientMetadataUrl(input.host),
  client_name: `Bastion MCP Gateway (${input.orgName})`,
  redirect_uris: [upstreamCallbackUrl(input.host)],
  application_type: 'web',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_signing_alg: 'ES256',
  jwks_uri: upstreamJwksUrl(input.host),
});

/** The document served at `/oauth/upstream/jwks`: public parts of the `upstream-client` keyring (22.3). */
export const buildUpstreamJwksDocument = async (
  source: SigningKeySource,
  now: Date,
): Promise<{ keys: Record<string, string>[] }> =>
  buildJwks(await source.listSigningKeys('upstream-client'), now);

export type ResolvedClient = {
  clientId: string;
  registration: 'preRegistered' | 'cimd' | 'dcr';
  auth: client.ClientAuth;
};

export type ClientIdentityDeps = {
  host: string;
  orgName: string;
  clients: UpstreamClientStore;
  secrets: SecretStore;
  signingKeys: SigningKeySource;
  /** SSRF-guarded fetch for RFC 7591 registration. */
  fetch: FetchFn;
  clock?: Clock;
};

const dcrResponse = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const secretRefFor = (issuer: string) => ({
  scope: 'system' as const,
  ownerId: null,
  name: `upstream-client:${issuer}`,
});

const privateKeyAuth = async (deps: ClientIdentityDeps): Promise<client.ClientAuth> => {
  const now = (deps.clock ?? systemClock).now();
  const keys = (await deps.signingKeys.listSigningKeys('upstream-client'))
    .filter((k) => k.activeFrom.getTime() <= now && k.retireAfter.getTime() > now)
    .sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime());
  const active = keys[0];
  if (!active) throw new UpstreamClientError('no active upstream-client signing key');
  const jwk = await deps.signingKeys.loadSigningPrivateKey(active.kid);
  const key = await importJWK(jwk, 'ES256');
  return client.PrivateKeyJwt({ key: key as client.PrivateKey['key'], kid: active.kid });
};

const secretAuth = (
  method: 'client_secret_basic' | 'client_secret_post' | 'none',
  secret: string | null,
): client.ClientAuth => {
  if (method === 'none' || secret === null) return client.None();
  return method === 'client_secret_post'
    ? client.ClientSecretPost(secret)
    : client.ClientSecretBasic(secret);
};

const registerDynamically = async (
  deps: ClientIdentityDeps,
  discovery: UpstreamDiscovery,
): Promise<UpstreamClientRow> => {
  if (!discovery.registrationEndpoint) {
    throw new UpstreamClientError('authorization server offers no client registration');
  }
  const methods = discovery.tokenEndpointAuthMethods;
  const authMethod =
    !methods || methods.includes('client_secret_basic')
      ? 'client_secret_basic'
      : methods.includes('none')
        ? 'none'
        : 'client_secret_post';
  const redirectUri = upstreamCallbackUrl(deps.host);
  const response = await deps.fetch(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: `Bastion MCP Gateway (${deps.orgName})`,
      redirect_uris: [redirectUri],
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
    }),
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new OAuthProtocolError('dynamic client registration failed', { status: response.status });
  }
  const parsed = dcrResponse.parse(await response.json());
  let clientSecretId: string | null = null;
  if (parsed.client_secret) {
    clientSecretId = (await deps.secrets.put(secretRefFor(discovery.issuer), parsed.client_secret))
      .id;
  }
  const row: UpstreamClientRow = {
    issuer: discovery.issuer,
    registration: 'dcr',
    clientId: parsed.client_id,
    clientSecretId,
    metadata: {
      issuer: discovery.issuer,
      redirect_uris: [redirectUri],
      application_type: 'web',
      token_endpoint_auth_method: parsed.client_secret
        ? (parsed.token_endpoint_auth_method ?? authMethod)
        : 'none',
    },
  };
  await deps.clients.put(row);
  return row;
};

const fromRow = async (
  deps: ClientIdentityDeps,
  row: UpstreamClientRow,
): Promise<ResolvedClient> => {
  const secret = row.clientSecretId ? await deps.secrets.revealById(row.clientSecretId) : null;
  const method = z
    .enum(['client_secret_basic', 'client_secret_post', 'none'])
    .catch('client_secret_basic')
    .parse(row.metadata.token_endpoint_auth_method);
  return {
    clientId: row.clientId,
    registration: row.registration,
    auth: secretAuth(method, secret),
  };
};

/** A stored DCR registration is only valid for the same issuer and the current redirect URI. */
const dcrRowUsable = (deps: ClientIdentityDeps, row: UpstreamClientRow, issuer: string): boolean =>
  row.registration === 'dcr' &&
  row.issuer === issuer &&
  row.metadata.issuer === issuer &&
  Array.isArray(row.metadata.redirect_uris) &&
  row.metadata.redirect_uris.includes(upstreamCallbackUrl(deps.host));

/**
 * Chooses the client identity at the upstream AS (9.6): `preRegistered`, `cimd`, `dcr` or `auto`
 * (pre-registered row for the issuer, else CIMD when the AS supports it, else DCR).
 */
export const resolveClientIdentity = async (
  deps: ClientIdentityDeps,
  spec: UpstreamOAuthClientSpec,
  discovery: UpstreamDiscovery,
): Promise<ResolvedClient> => {
  const existing = await deps.clients.get(discovery.issuer);
  const useDcr = async (): Promise<ResolvedClient> => {
    const row =
      existing && dcrRowUsable(deps, existing, discovery.issuer)
        ? existing
        : await registerDynamically(deps, discovery);
    return fromRow(deps, row);
  };
  const useCimd = async (): Promise<ResolvedClient> => {
    if (!discovery.cimdSupported) {
      throw new UpstreamClientError(
        'authorization server does not support client ID metadata documents',
      );
    }
    return {
      clientId: upstreamClientMetadataUrl(deps.host),
      registration: 'cimd',
      auth: await privateKeyAuth(deps),
    };
  };
  switch (spec.registration) {
    case 'preRegistered': {
      const secret = spec.clientSecretRef
        ? await deps.secrets.reveal({ scope: 'org', ownerId: null, name: spec.clientSecretRef })
        : null;
      if (spec.authMethod !== 'none' && spec.authMethod !== 'private_key_jwt' && secret === null) {
        throw new UpstreamClientError('pre-registered client secret is missing');
      }
      const auth =
        spec.authMethod === 'private_key_jwt'
          ? await privateKeyAuth(deps)
          : secretAuth(spec.authMethod === 'none' ? 'none' : spec.authMethod, secret);
      return { clientId: spec.clientId, registration: 'preRegistered', auth };
    }
    case 'cimd':
      return useCimd();
    case 'dcr':
      return useDcr();
    case 'auto': {
      if (existing?.registration === 'preRegistered' && existing.issuer === discovery.issuer) {
        return fromRow(deps, existing);
      }
      if (discovery.cimdSupported) return useCimd();
      return useDcr();
    }
  }
};

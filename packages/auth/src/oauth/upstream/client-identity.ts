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
import {
  originOf,
  upstreamCallbackUrl,
  upstreamClientMetadataUrl,
  upstreamJwksUrl,
  upstreamPublicClientMetadataUrl,
} from '../urls';
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

/**
 * The document served at `/oauth/upstream/client-metadata-public.json`: the same client as a public client (`none`,
 * PKCE). Used for authorization servers that support CIMD but not `private_key_jwt` (Linear and Notion advertise
 * only `client_secret_basic`, `client_secret_post` and `none`).
 */
export const buildUpstreamPublicClientMetadata = (input: { host: string; orgName: string }) => ({
  client_id: upstreamPublicClientMetadataUrl(input.host),
  client_name: `Bastion MCP Gateway (${input.orgName})`,
  redirect_uris: [upstreamCallbackUrl(input.host)],
  application_type: 'web',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

/**
 * The AS fetches our metadata document itself, so the origin must be public HTTPS. `http://localhost:8080` (an
 * evaluation setup) or a private address can never be fetched by a third-party AS.
 */
export const cimdReachable = (host: string): boolean => {
  const url = new URL(originOf(host));
  if (url.protocol !== 'https:') return false;
  const name = url.hostname.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return false;
  if (name.includes(':')) return !/^\[?(::1?|f[cd]|fe80)/i.test(name);
  const octets = name.split('.').map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n))) {
    const [a = 0, b = 0] = octets;
    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return true;
};

/**
 * How we authenticate at a CIMD-capable AS: `private_key_jwt` unless the AS lists its methods without it, then
 * `none`; null when it accepts neither.
 */
export const cimdAuthMethod = (discovery: UpstreamDiscovery): 'private_key_jwt' | 'none' | null => {
  const methods = discovery.tokenEndpointAuthMethods;
  if (!methods || methods.includes('private_key_jwt')) return 'private_key_jwt';
  return methods.includes('none') ? 'none' : null;
};

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
  /** `auto` only: this issuer already refused our CIMD identity, so go straight to DCR. */
  cimdRejected?: boolean;
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
  if (response.status < 200 || response.status >= 300) {
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
 * (pre-registered row for the issuer, else CIMD when the AS supports it and has not refused it, else DCR).
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
  const useCimd = async (bestEffort = false): Promise<ResolvedClient> => {
    if (!discovery.cimdSupported) {
      throw new UpstreamClientError(
        'authorization server does not support client ID metadata documents',
      );
    }
    if (!bestEffort && !cimdReachable(deps.host)) {
      throw new UpstreamClientError(
        'client ID metadata documents need a public HTTPS origin; this deployment is not reachable by the authorization server',
      );
    }
    const method = cimdAuthMethod(discovery);
    if (method === null) {
      throw new UpstreamClientError(
        'authorization server supports client ID metadata documents but accepts neither private_key_jwt nor public clients',
      );
    }
    return method === 'none'
      ? {
          clientId: upstreamPublicClientMetadataUrl(deps.host),
          registration: 'cimd',
          auth: client.None(),
        }
      : {
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
      const cimdOffered =
        discovery.cimdSupported && !deps.cimdRejected && cimdAuthMethod(discovery) !== null;
      if (cimdOffered && cimdReachable(deps.host)) return useCimd();
      if (discovery.registrationEndpoint) return useDcr();
      // No registration endpoint and an origin the AS cannot fetch (a LAN or localhost deployment): still offer
      // our CIMD client ID. An AS that never fetches it when the redirect URI shares its host (Home Assistant's
      // IndieAuth) accepts it, as it does the loopback clients of desktop apps; any other AS rejects it at authorize.
      if (cimdOffered) return useCimd(true);
      return useDcr();
    }
  }
};

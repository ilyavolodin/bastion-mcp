import { z } from 'zod';
import type { FetchFn } from '../ports';
import { OutboundDeniedError } from '../safe-fetch';

/** Discovery of an upstream MCP server's authorization server (9.6). */
export class UpstreamDiscoveryError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'no_protected_resource_metadata'
      | 'no_authorization_server'
      | 'no_authorization_server_metadata'
      | 'pkce_s256_required'
      | 'issuer_mismatch'
      | 'unreachable',
  ) {
    super(message);
    this.name = 'UpstreamDiscoveryError';
  }
}

const prmSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const asMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  jwks_uri: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
});

export type UpstreamDiscovery = {
  /** Canonical MCP URL, used as the RFC 8707 `resource`. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopesSupported: string[];
  grantTypesSupported: string[] | null;
  tokenEndpointAuthMethods: string[] | null;
  issParameterSupported: boolean;
  cimdSupported: boolean;
  /** The raw AS metadata for openid-client. */
  metadata: z.infer<typeof asMetadataSchema>;
};

/** Parses `Bearer a="b", c=d` challenge parameters. */
export const parseChallengeParams = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const match of header.matchAll(/([A-Za-z_][\w-]*)=(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = match[1];
    if (key) out[key.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return out;
};

const getJson = async (fetchFn: FetchFn, url: string): Promise<unknown | null> => {
  try {
    const response = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (response.status !== 200) return null;
    return await response.json();
  } catch (error) {
    if (error instanceof OutboundDeniedError) throw error;
    return null;
  }
};

/** RFC 9728 well-known URL candidates for a resource URL (path-inserted first, then root). */
const prmCandidates = (resource: URL): string[] => {
  const path = resource.pathname === '/' ? '' : resource.pathname.replace(/\/$/, '');
  const inserted = `${resource.origin}/.well-known/oauth-protected-resource${path}`;
  const root = `${resource.origin}/.well-known/oauth-protected-resource`;
  return path ? [inserted, root] : [root];
};

/** RFC 8414 (path-inserted) then OIDC discovery (appended and path-inserted) candidates. */
const asCandidates = (issuer: URL): string[] => {
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
};

const sameOriginPrefix = (resource: string, mcpUrl: URL): boolean => {
  try {
    const r = new URL(resource);
    return r.origin === mcpUrl.origin && mcpUrl.pathname.startsWith(r.pathname.replace(/\/$/, ''));
  } catch {
    return false;
  }
};

/**
 * Calls the upstream without a token, follows `resource_metadata` (or the well-known paths) to the first
 * authorization server and loads its metadata. Refuses when `S256` is not advertised (MUST, 9.6).
 */
export const discoverUpstream = async (input: {
  mcpUrl: string;
  fetch: FetchFn;
}): Promise<UpstreamDiscovery> => {
  const mcp = new URL(input.mcpUrl);
  let resourceMetadataUrl: string | undefined;
  try {
    const probe = await input.fetch(input.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
    if (probe.status === 401) {
      resourceMetadataUrl = parseChallengeParams(
        probe.headers.get('www-authenticate'),
      ).resource_metadata;
    }
    await probe.body?.cancel();
  } catch (error) {
    if (error instanceof OutboundDeniedError) throw error;
    // Fall through to the well-known paths; an unreachable upstream fails there.
  }
  const candidates = resourceMetadataUrl ? [resourceMetadataUrl] : prmCandidates(mcp);
  let prm: z.infer<typeof prmSchema> | null = null;
  for (const url of candidates) {
    const parsed = prmSchema.safeParse(await getJson(input.fetch, url));
    if (parsed.success) {
      prm = parsed.data;
      break;
    }
  }
  if (!prm) {
    throw new UpstreamDiscoveryError(
      'upstream publishes no protected resource metadata',
      'no_protected_resource_metadata',
    );
  }
  const issuerUrl = prm.authorization_servers[0];
  if (!issuerUrl)
    throw new UpstreamDiscoveryError('no authorization server listed', 'no_authorization_server');
  let issuer: URL;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    throw new UpstreamDiscoveryError('invalid authorization server URL', 'no_authorization_server');
  }
  let metadata: z.infer<typeof asMetadataSchema> | null = null;
  for (const url of asCandidates(issuer)) {
    const parsed = asMetadataSchema.safeParse(await getJson(input.fetch, url));
    if (parsed.success) {
      metadata = parsed.data;
      break;
    }
  }
  if (!metadata) {
    throw new UpstreamDiscoveryError(
      'authorization server metadata not found',
      'no_authorization_server_metadata',
    );
  }
  if (metadata.issuer !== issuerUrl && metadata.issuer !== issuerUrl.replace(/\/$/, '')) {
    throw new UpstreamDiscoveryError('authorization server issuer mismatch', 'issuer_mismatch');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new UpstreamDiscoveryError(
      'upstream authorization server does not support PKCE S256',
      'pkce_s256_required',
    );
  }
  const resource = prm.resource && sameOriginPrefix(prm.resource, mcp) ? prm.resource : mcp.href;
  return {
    resource,
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint ?? null,
    revocationEndpoint: metadata.revocation_endpoint ?? null,
    scopesSupported: prm.scopes_supported ?? metadata.scopes_supported ?? [],
    grantTypesSupported: metadata.grant_types_supported ?? null,
    tokenEndpointAuthMethods: metadata.token_endpoint_auth_methods_supported ?? null,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    cimdSupported: metadata.client_id_metadata_document_supported === true,
    metadata,
  };
};

import { ENTERPRISE_MANAGED_EXTENSION } from './constants';

/**
 * URL builders for one deployment (9.3). The `host` argument is either a bare host (`bastion.example.com`, which means
 * https) or the full public origin (`http://localhost:8080`). Pass the origin: an evaluation setup runs on plain http,
 * and building `https://` URLs for it makes every OAuth client fail with "resource indicator is missing, or unknown".
 */
export const originOf = (hostOrOrigin: string): string =>
  /^https?:\/\//i.test(hostOrOrigin) ? new URL(hostOrOrigin).origin : `https://${hostOrOrigin}`;

export const issuerFor = (host: string): string => `${originOf(host)}/oauth`;
export const mcpResource = (host: string): string => `${originOf(host)}/mcp`;
export const apiResource = (host: string): string => `${originOf(host)}/api`;

/** RFC 8707: any URI under /mcp (exact or path child) or exactly /api, on this deployment's own origin. */
export const isAllowedResource = (host: string, resource: string): boolean => {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.origin !== originOf(host) || url.hash !== '') return false;
  if (url.username || url.password) return false;
  const path = url.pathname;
  return path === '/api' || path === '/mcp' || path.startsWith('/mcp/');
};

export const connectUrl = (host: string, installationId: string): string =>
  `${originOf(host)}/connect/${encodeURIComponent(installationId)}`;
export const upstreamCallbackUrl = (host: string): string =>
  `${originOf(host)}/oauth/upstream/callback`;
export const upstreamClientMetadataUrl = (host: string): string =>
  `${originOf(host)}/oauth/upstream/client-metadata.json`;
export const upstreamJwksUrl = (host: string): string => `${originOf(host)}/oauth/upstream/jwks`;
export const idpCallbackUrl = (host: string, connectionId: string): string =>
  `${originOf(host)}/auth/callback/${connectionId}`;
/**
 * The redirect URI of an IdP connection (9.1): `/auth/callback/{id}`, or the bare site origin for an IdP that registers
 * nothing but the origin (Synology SSO Server). The origin form has NO trailing slash, exactly as such an IdP has it
 * registered and compares it; `new URL(...)` would add one (see `withRedirectUriAsSent`).
 */
export const idpRedirectUri = (
  host: string,
  connection: { id: string; redirectToRoot: boolean },
): string => (connection.redirectToRoot ? originOf(host) : idpCallbackUrl(host, connection.id));

/** Protected Resource Metadata for any exact path variant of /mcp (9.3, RFC 9728). */
export const buildProtectedResourceMetadata = (input: {
  host: string;
  orgName: string;
  path?: string;
  enterpriseManaged?: boolean;
}): Record<string, unknown> => ({
  resource: `${originOf(input.host)}${input.path ?? '/mcp'}`,
  authorization_servers: [issuerFor(input.host)],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header'],
  resource_name: `${input.orgName} MCP`,
  ...(input.enterpriseManaged ? { extensions_supported: [ENTERPRISE_MANAGED_EXTENSION] } : {}),
});

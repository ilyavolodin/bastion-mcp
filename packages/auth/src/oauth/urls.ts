import { ENTERPRISE_MANAGED_EXTENSION } from './constants';

/** URL builders for one deployment host (9.3). */
export const issuerFor = (host: string): string => `https://${host}/oauth`;
export const mcpResource = (host: string): string => `https://${host}/mcp`;
export const apiResource = (host: string): string => `https://${host}/api`;

/** RFC 8707: any URI under /mcp (exact or path child) or exactly /api. */
export const isAllowedResource = (host: string, resource: string): boolean => {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.host !== host || url.hash !== '') return false;
  if (url.username || url.password) return false;
  const path = url.pathname;
  return path === '/api' || path === '/mcp' || path.startsWith('/mcp/');
};

export const connectUrl = (host: string, installationId: string): string =>
  `https://${host}/connect/${encodeURIComponent(installationId)}`;
export const upstreamCallbackUrl = (host: string): string =>
  `https://${host}/oauth/upstream/callback`;
export const upstreamClientMetadataUrl = (host: string): string =>
  `https://${host}/oauth/upstream/client-metadata.json`;
export const upstreamJwksUrl = (host: string): string => `https://${host}/oauth/upstream/jwks`;
export const idpCallbackUrl = (host: string, connectionId: string): string =>
  `https://${host}/auth/callback/${connectionId}`;

/** Protected Resource Metadata for any exact path variant of /mcp (9.3, RFC 9728). */
export const buildProtectedResourceMetadata = (input: {
  host: string;
  orgName: string;
  path?: string;
  enterpriseManaged?: boolean;
}): Record<string, unknown> => ({
  resource: `https://${input.host}${input.path ?? '/mcp'}`,
  authorization_servers: [issuerFor(input.host)],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header'],
  resource_name: `${input.orgName} MCP`,
  ...(input.enterpriseManaged ? { extensions_supported: [ENTERPRISE_MANAGED_EXTENSION] } : {}),
});

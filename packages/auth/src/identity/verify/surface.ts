import { SCOPES } from '@bastion-mcp/core';

/** The three resource surfaces and the scope each one accepts (9.3, 25.6). */
export type Surface = 'mcp' | 'api' | 'plugins';

const hasSegmentPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

export const surfaceForPath = (pathname: string): Surface | null => {
  if (hasSegmentPrefix(pathname, '/mcp')) return 'mcp';
  if (hasSegmentPrefix(pathname, '/api')) return 'api';
  if (hasSegmentPrefix(pathname, '/plugins')) return 'plugins';
  return null;
};

/** Scopes any one of which authorises the surface. Separation: no scope grants another surface. */
export const ACCEPTED_SCOPES: Record<Surface, readonly string[]> = {
  mcp: [SCOPES.mcp],
  api: [SCOPES.apiRead, SCOPES.apiWrite],
  plugins: [SCOPES.pluginsRead],
};

/** The scope advertised in challenges for a surface. */
export const CHALLENGE_SCOPE: Record<Surface, string> = {
  mcp: SCOPES.mcp,
  api: SCOPES.apiRead,
  plugins: SCOPES.pluginsRead,
};

export const scopeAllowed = (surface: Surface, scopes: readonly string[]): boolean =>
  ACCEPTED_SCOPES[surface].some((s) => scopes.includes(s));

const escapeQuoted = (v: string): string => v.replace(/["\\]/g, '');

/** 6.9: `Bearer resource_metadata="...", scope="mcp"`; Basic realm for the plugin git channel. */
export const buildChallenge = (opts: {
  surface: Surface;
  baseUrl: string;
  pathname: string;
  error?: 'invalid_token' | 'insufficient_scope';
  basic?: boolean;
}): string => {
  if (opts.basic) return 'Basic realm="Bastion plugins"';
  const metadata = `${opts.baseUrl}/.well-known/oauth-protected-resource${opts.pathname}`;
  const parts = [
    ...(opts.error ? [`error="${opts.error}"`] : []),
    `resource_metadata="${escapeQuoted(metadata)}"`,
    `scope="${CHALLENGE_SCOPE[opts.surface]}"`,
  ];
  return `Bearer ${parts.join(', ')}`;
};

/** Endpoint URLs, protected resource metadata, audiences and slug collisions (7.1). */
import { BastionError, effectiveTeamSlug } from '@bastion-mcp/core';
import type { EndpointDefinition, InstallationInfo } from './types';

/** Effective slugs may be `{teamSlug}-{slug}`, so up to 40 + 1 + 40 characters. */
const SLUG = /^[a-z0-9-]{2,81}$/;

export type ParsedEndpointPath =
  | { kind: 'default' }
  | { kind: 'named'; slug: string }
  | { kind: 'installation'; slug: string }
  | { kind: 'catalog'; slug: string };

const KIND_BY_SEGMENT = { e: 'named', i: 'installation', c: 'catalog' } as const;

/** `/mcp`, `/mcp/e/{slug}`, `/mcp/i/{slug}`, `/mcp/c/{slug}`; anything else (or a malformed slug) is `null`. */
export const parseEndpointPath = (path: string): ParsedEndpointPath | null => {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (trimmed === '/mcp') return { kind: 'default' };
  const parts = trimmed.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'mcp') return null;
  const segment = parts[2] as string;
  const slug = parts[3] as string;
  if (!(segment in KIND_BY_SEGMENT) || !SLUG.test(slug)) return null;
  return { kind: KIND_BY_SEGMENT[segment as keyof typeof KIND_BY_SEGMENT], slug };
};

const WELL_KNOWN = '/.well-known/oauth-protected-resource';

/** The endpoint path a protected-resource-metadata path stands for (RFC 9728), or `null`. */
export const parseProtectedResourcePath = (
  path: string,
): { resourcePath: string; endpoint: ParsedEndpointPath } | null => {
  if (!path.startsWith(`${WELL_KNOWN}/`)) return null;
  const resourcePath = path.slice(WELL_KNOWN.length);
  const endpoint = parseEndpointPath(resourcePath);
  return endpoint ? { resourcePath, endpoint } : null;
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ['header'];
  scopes_supported?: string[];
};

/** Every endpoint URL is its own protected resource and returns its own exact URL (7.1). */
export const protectedResourceMetadata = (
  path: string,
  options: { baseUrl: string; authorizationServers: string[]; scopesSupported?: string[] },
): ProtectedResourceMetadata | null => {
  const parsed = parseProtectedResourcePath(path);
  if (!parsed) return null;
  const doc: ProtectedResourceMetadata = {
    resource: `${options.baseUrl.replace(/\/+$/, '')}${parsed.resourcePath}`,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ['header'],
  };
  if (options.scopesSupported) doc.scopes_supported = options.scopesSupported;
  return doc;
};

/** True when `aud` is `https://<host>/mcp` or a path prefix of the request URL (7.1). */
export const isAudienceAccepted = (
  tokenAud: string | readonly string[],
  requestUrl: string,
): boolean => {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  const requestPath = request.pathname.replace(/\/+$/, '');
  const auds = typeof tokenAud === 'string' ? [tokenAud] : tokenAud;
  return auds.some((aud) => {
    let url: URL;
    try {
      url = new URL(aud);
    } catch {
      return false;
    }
    if (url.origin !== request.origin || url.search !== '' || url.hash !== '') return false;
    const audPath = url.pathname.replace(/\/+$/, '');
    if (audPath !== '/mcp' && !audPath.startsWith('/mcp/')) return false;
    return requestPath === audPath || requestPath.startsWith(`${audPath}/`);
  });
};

export class AudienceRejectedError extends BastionError {
  constructor() {
    super('INVALID_TOKEN', 'Token audience does not match this resource', { httpStatus: 401 });
  }
}

export const assertAudienceAccepted = (
  tokenAud: string | readonly string[],
  requestUrl: string,
): void => {
  if (!isAudienceAccepted(tokenAud, requestUrl)) throw new AudienceRejectedError();
};

// --- slugs ----------------------------------------------------------------------------------------

/** The slug clients see: a team installation is `{teamSlug}-{slug}` (7.1). */
export const effectiveSlug = (installation: Pick<InstallationInfo, 'slug' | 'owner'>): string =>
  installation.owner.kind === 'team'
    ? effectiveTeamSlug(installation.owner.slug, installation.slug)
    : installation.slug;

export class SlugCollisionError extends BastionError {
  constructor(slug: string) {
    super('SLUG_COLLISION', `Slug "${slug}" is already used by an installation you can see`, {
      httpStatus: 409,
      data: { slug },
    });
  }
}

/** Creating a user installation fails when its slug equals any effective slug the user can see (7.1). */
export const assertInstallationSlugAvailable = (
  slug: string,
  visible: ReadonlyArray<Pick<InstallationInfo, 'slug' | 'owner'>>,
): void => {
  if (visible.some((i) => effectiveSlug(i) === slug)) throw new SlugCollisionError(slug);
};

/** Maps a parsed path to the endpoint definition (7.1); `null` when the slug names nothing visible. */
export const resolveEndpointDefinition = (
  parsed: ParsedEndpointPath,
  data: {
    installations: readonly InstallationInfo[];
    namedEndpoints: readonly EndpointDefinition[];
  },
): EndpointDefinition | null => {
  switch (parsed.kind) {
    case 'default':
      return { id: 'default', kind: 'default', prefixMode: 'always' };
    case 'named':
      return data.namedEndpoints.find((e) => e.slug === parsed.slug) ?? null;
    case 'installation': {
      const inst = data.installations.find((i) => effectiveSlug(i) === parsed.slug);
      return inst
        ? {
            id: `i:${inst.id}`,
            kind: 'installation',
            installationIds: [inst.id],
            prefixMode: 'onCollision',
          }
        : null;
    }
    case 'catalog': {
      const inst = data.installations.find((i) => i.catalogSlug === parsed.slug);
      return inst
        ? {
            id: `c:${parsed.slug}`,
            kind: 'catalog',
            installationIds: [inst.id],
            prefixMode: 'onCollision',
          }
        : null;
    }
  }
};

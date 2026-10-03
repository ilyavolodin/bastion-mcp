import { isRecord } from '@bastion-mcp/core';
import { z } from 'zod';
import type { ClaimMap, IdpConnection } from '../ports';

/** Normalized user profile from an IdP (9.1). */
export type NormalizedProfile = {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  issuer: string;
  connectionId: string;
};

export class IdpClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdpClaimError';
  }
}

export const DEFAULT_CLAIM_MAP: ClaimMap = {
  email: 'email',
  name: 'name',
  groups: 'groups',
  sub: 'sub',
};

export const claimMapSchema = z.object({
  email: z.string().min(1),
  name: z.string().min(1),
  groups: z.string().min(1),
  sub: z.string().min(1),
});

const read = (claims: Record<string, unknown>, path: string): unknown => {
  if (path in claims) return claims[path];
  // dotted paths such as `realm_access.roles`
  return path.split('.').reduce<unknown>((value, part) => {
    return isRecord(value) ? value[part] : undefined;
  }, claims);
};

const asStringList = (value: unknown): string[] => {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
};

export const emailDomain = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export const isEmailDomainAllowed = (
  connection: Pick<IdpConnection, 'emailDomains'>,
  email: string,
): boolean =>
  connection.emailDomains.length === 0 ||
  connection.emailDomains.map((d) => d.toLowerCase()).includes(emailDomain(email));

/** Maps ID token / userinfo claims through the connection's `claim_map` and applies the domain allowlist. */
export const mapClaims = (
  claims: Record<string, unknown>,
  connection: IdpConnection,
): NormalizedProfile => {
  const map = connection.claimMap;
  const sub = read(claims, map.sub);
  if (typeof sub !== 'string' || sub.length === 0)
    throw new IdpClaimError('IdP did not return a subject');
  const email = read(claims, map.email);
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new IdpClaimError('IdP did not return an email address');
  }
  if (claims.email_verified === false) throw new IdpClaimError('email address is not verified');
  if (!isEmailDomainAllowed(connection, email)) {
    throw new IdpClaimError('email domain is not allowed for this connection');
  }
  const name = read(claims, map.name);
  return {
    sub,
    email: email.toLowerCase(),
    name: typeof name === 'string' && name.length > 0 ? name : email,
    groups: asStringList(read(claims, map.groups)),
    issuer: connection.issuer,
    connectionId: connection.id,
  };
};

/** Scopes requested at login: `openid email profile` by default (9.1). */
export const loginScopes = (connection: IdpConnection): string[] => {
  const base =
    connection.scopes.length > 0 ? [...connection.scopes] : ['openid', 'email', 'profile'];
  if (!base.includes('openid')) base.unshift('openid');
  if (connection.storeRefreshToken) base.push('offline_access');
  if (connection.apiScope) base.push(...connection.apiScope.split(' ').filter(Boolean));
  return [...new Set(base)];
};

/**
 * Login page routing (9.1): the connection whose domain list contains the email's domain; when none
 * lists it, the only enabled connection without a domain list; otherwise null (caller asks the user).
 */
export const routeByEmail = (
  connections: readonly IdpConnection[],
  email: string,
): IdpConnection | null => {
  const enabled = connections.filter((c) => c.enabled);
  const domain = emailDomain(email);
  const matched = enabled.filter((c) =>
    c.emailDomains.map((d) => d.toLowerCase()).includes(domain),
  );
  if (matched.length === 1) return matched[0] ?? null;
  if (matched.length > 1) return null;
  const open = enabled.filter((c) => c.emailDomains.length === 0);
  return open.length === 1 ? (open[0] ?? null) : null;
};

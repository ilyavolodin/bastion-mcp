import { z } from 'zod';
import { ProvisioningDeniedError } from '../errors';

export type ClaimMap = { email?: string; name?: string; groups?: string; sub?: string };

/** The parts of `idp_connections` (16.2) that provisioning needs. */
export type IdpConnection = {
  id: string;
  issuer: string;
  claimMap: ClaimMap;
  emailDomains: readonly string[];
  enabled: boolean;
};

export type IdentityClaims = {
  sub: string;
  email: string;
  displayName: string;
  groups: string[];
};

const MAX_GROUPS = 500;

const lookup = (claims: Record<string, unknown>, path: string): unknown => {
  if (path in claims) return claims[path];
  let current: unknown = claims;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const groupList = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const cleaned = raw
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.trim())
    .filter((g) => g.length > 0 && g.length <= 256);
  return [...new Set(cleaned)].slice(0, MAX_GROUPS);
};

export const isEmailDomainAllowed = (email: string, domains: readonly string[]): boolean => {
  if (domains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domains.some((d) => d.toLowerCase() === domain);
};

/** 9.1: `users.external_subject` = issuer + `sub`. */
export const externalSubjectFor = (issuer: string, sub: string): string => `${issuer}#${sub}`;

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+$/);

/** Maps verified OIDC claims through the connection's claim map (9.1); never trusts unverified email. */
export const mapClaims = (raw: unknown, connection: IdpConnection): IdentityClaims => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProvisioningDeniedError('identity claims are missing', 'claims');
  }
  const claims = raw as Record<string, unknown>;
  const map = connection.claimMap;
  const subRaw = lookup(claims, map.sub ?? 'sub');
  const sub = typeof subRaw === 'string' || typeof subRaw === 'number' ? String(subRaw) : '';
  if (!sub) throw new ProvisioningDeniedError('identity has no subject', 'sub');
  const emailParsed = emailSchema.safeParse(lookup(claims, map.email ?? 'email'));
  if (!emailParsed.success) throw new ProvisioningDeniedError('identity has no email', 'email');
  if (claims.email_verified === false) {
    throw new ProvisioningDeniedError('email is not verified', 'email_unverified');
  }
  const email = emailParsed.data.toLowerCase();
  if (!isEmailDomainAllowed(email, connection.emailDomains)) {
    throw new ProvisioningDeniedError('email domain is not allowed', 'email_domain');
  }
  const nameRaw = lookup(claims, map.name ?? 'name');
  const displayName =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : (email.split('@')[0] ?? email);
  return { sub, email, displayName, groups: groupList(lookup(claims, map.groups ?? 'groups')) };
};

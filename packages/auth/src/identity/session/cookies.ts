import { timingSafeEqual } from 'node:crypto';
import { HEADERS, sha256Hex } from '@bastion-mcp/core';
import { CsrfError } from '../errors';

export const SESSION_COOKIE = 'bastion_sid';
export const CSRF_COOKIE = 'bastion_csrf';
export const CSRF_HEADER = HEADERS.csrf;

type CookieOptions = { secure?: boolean };

const cookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  attrs: { httpOnly: boolean },
  opts: CookieOptions,
): string =>
  [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    ...(attrs.httpOnly ? ['HttpOnly'] : []),
    // Secure is the default; callers disable it only for loopback development (never in production).
    ...(opts.secure === false ? [] : ['Secure']),
    'SameSite=Lax',
  ].join('; ');

/** 9.2: `bastion_sid` is HttpOnly, Secure and SameSite=Lax. */
export const sessionCookie = (
  id: string,
  maxAgeSeconds: number,
  opts: CookieOptions = {},
): string => cookie(SESSION_COOKIE, id, maxAgeSeconds, { httpOnly: true }, opts);

/** 9.2: the SPA reads `bastion_csrf` and echoes it in `x-bastion-csrf`, so it is not HttpOnly. */
export const csrfCookie = (
  token: string,
  maxAgeSeconds: number,
  opts: CookieOptions = {},
): string => cookie(CSRF_COOKIE, token, maxAgeSeconds, { httpOnly: false }, opts);

export const clearSessionCookies = (opts: CookieOptions = {}): string[] => [
  cookie(SESSION_COOKIE, '', 0, { httpOnly: true }, opts),
  cookie(CSRF_COOKIE, '', 0, { httpOnly: false }, opts),
];

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
};

const digest = (v: string): Buffer => Buffer.from(sha256Hex(v), 'hex');

/** 9.2 double submit: header equals cookie, compared in constant time (digests hide the length). */
export const checkCsrf = (
  cookieHeader: string | undefined,
  headerValue: string | undefined,
): boolean => {
  const fromCookie = parseCookies(cookieHeader)[CSRF_COOKIE];
  if (!fromCookie || !headerValue) return false;
  return timingSafeEqual(digest(fromCookie), digest(headerValue));
};

export const assertCsrf = (
  cookieHeader: string | undefined,
  headerValue: string | undefined,
): void => {
  if (!checkCsrf(cookieHeader, headerValue)) throw new CsrfError();
};

export const isStateChanging = (method: string): boolean =>
  !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

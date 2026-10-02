/** Shared helpers of the server-rendered auth pages: cookies, CSRF, safe redirects, sending HTML. */
import { randomBytes } from 'node:crypto';
import type { Principal } from '@bastion-mcp/auth';
import {
  CSRF_COOKIE,
  checkCsrf,
  csrfCookie,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from '@bastion-mcp/auth';
import { TTL } from '@bastion-mcp/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthServices } from '../../contracts';
import type { Infra } from '../../infra';
import { type ErrorPageInput, errorPage as renderErrorPage } from '../pages/templates';

export type UiDeps = { infra: Infra; auth: AuthServices };

/** Strict CSP of the server-rendered pages (9.2): own stylesheet, fonts and theme script only; no inline script or
 * style; `form-action` is left open because OAuth redirects follow form posts. */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

export const sendHtml = (reply: FastifyReply, status: number, html: string): FastifyReply =>
  reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', PAGE_CSP)
    .header('referrer-policy', 'no-referrer')
    .send(html);

export const errorPage = (
  reply: FastifyReply,
  status: number,
  message: string,
  options: Omit<ErrorPageInput, 'message'> = {},
): FastifyReply => sendHtml(reply, status, renderErrorPage({ ...options, message }));

/** `Secure` cookies unless the public URL is plain http on loopback (development only). */
export const cookiesSecure = (infra: Infra): boolean =>
  new URL(infra.config.publicUrl).protocol === 'https:';

export const addCookie = (reply: FastifyReply, cookie: string): void => {
  const previous = reply.getHeader('set-cookie');
  const list = Array.isArray(previous) ? previous : typeof previous === 'string' ? [previous] : [];
  reply.header('set-cookie', [...list, cookie]);
};

export const cookieValue = (req: FastifyRequest, name: string): string | undefined =>
  parseCookies(req.headers.cookie)[name];

const hasUnsafeChar = (value: string): boolean =>
  [...value].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** Only same-origin absolute paths (no `//host`, no backslashes or control characters) are followed. */
export const safeReturnTo = (raw: unknown, fallback = '/'): string => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || hasUnsafeChar(raw)) return fallback;
  return raw;
};

/** Double-submit token for server-rendered forms: reuses the `bastion_csrf` cookie, creating it when absent. */
export const ensureCsrf = ({ infra }: UiDeps, req: FastifyRequest, reply: FastifyReply): string => {
  const existing = cookieValue(req, CSRF_COOKIE);
  if (existing && existing.length >= 20) return existing;
  const token = randomBytes(32).toString('base64url');
  addCookie(reply, csrfCookie(token, TTL.uiSession, { secure: cookiesSecure(infra) }));
  return token;
};

/** True when the form field equals the CSRF cookie (constant-time compare is in `checkCsrf`). */
export const formCsrfOk = (req: FastifyRequest, field: unknown): boolean => {
  const cookie = cookieValue(req, CSRF_COOKIE);
  return (
    typeof field === 'string' &&
    typeof cookie === 'string' &&
    cookie.length > 0 &&
    field.length === cookie.length &&
    // the auth package compares digests in constant time
    checkCsrf(req.headers.cookie, field)
  );
};

/** The signed-in browser session as a principal, or null. */
export const sessionPrincipal = async (
  { auth }: UiDeps,
  req: FastifyRequest,
): Promise<Principal | null> => {
  const id = cookieValue(req, SESSION_COOKIE);
  if (!id) return null;
  return auth.sessions.authenticate(id);
};

/** Creates the browser session and sets `bastion_sid` and `bastion_csrf` (9.2). */
export const startSession = async (
  { infra, auth }: UiDeps,
  reply: FastifyReply,
  principalId: string,
): Promise<void> => {
  const created = await auth.sessions.create({ principalId });
  const secure = { secure: cookiesSecure(infra) };
  addCookie(reply, sessionCookie(created.id, created.ttlSeconds, secure));
  addCookie(reply, csrfCookie(created.csrfToken, created.ttlSeconds, secure));
};

/** Hands a Fastify reply to code that writes to the raw response (oidc-provider): headers set so far are kept. */
export const hijack = (reply: FastifyReply): void => {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value as string | string[] | number);
  }
  reply.hijack();
};

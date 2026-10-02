/** Shared helpers of the server-rendered auth pages: HTML escaping, cookies, CSRF, safe redirects. */
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

export type UiDeps = { infra: Infra; auth: AuthServices };

export const esc = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Strict CSP of the pages (9.2): no inline script or style; `form-action` is left open because OAuth redirects. */
export const PAGE_CSP =
  "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'";

export const CSS_PATH = '/ui-assets/auth.css';

export const AUTH_CSS = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(26rem, 92vw); padding: 1.5rem; border: 1px solid GrayText; border-radius: .75rem; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
p, li { line-height: 1.45; }
ul { padding-left: 1.2rem; }
form { display: grid; gap: .6rem; margin: .75rem 0; }
label { display: grid; gap: .2rem; font-size: .9rem; }
input[type=email], input[type=password], input[type=text] { padding: .5rem; font: inherit; }
button, a.button { padding: .55rem .9rem; font: inherit; cursor: pointer; text-align: center; text-decoration: none; border: 1px solid GrayText; border-radius: .4rem; background: ButtonFace; color: ButtonText; }
button.primary { background: AccentColor; color: AccentColorText; border-color: AccentColor; }
.row { display: flex; gap: .6rem; }
.muted { color: GrayText; font-size: .85rem; }
.error { color: #b00020; }
code { word-break: break-all; }
`;

export const layout = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="${CSS_PATH}"></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

export const sendHtml = (reply: FastifyReply, status: number, html: string): FastifyReply =>
  reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', PAGE_CSP)
    .header('referrer-policy', 'no-referrer')
    .send(html);

export const errorPage = (reply: FastifyReply, status: number, message: string): FastifyReply =>
  sendHtml(reply, status, layout('Something went wrong', `<p class="error">${esc(message)}</p>`));

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

/** Fixed-window counter in Redis; true when the call is allowed. */
export const allowAttempt = async (
  infra: Infra,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> => {
  const redisKey = `rl:ui:${key}`;
  const count = await infra.redis.incr(redisKey);
  if (count === 1) await infra.redis.expire(redisKey, windowSeconds);
  return count <= max;
};

/** Hands a Fastify reply to code that writes to the raw response (oidc-provider): headers set so far are kept. */
export const hijack = (reply: FastifyReply): void => {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value as string | string[] | number);
  }
  reply.hijack();
};

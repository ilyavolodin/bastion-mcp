import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DCR_LIMIT_PER_HOUR } from '../constants';
import type { ClientRegistrationSettings, RedisLike, RegistrationSettingsSource } from '../ports';

/** Registration policy (9.3): redirect URI rules of RFC 8252, CIMD allowlist, application_type default. */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
]);

export type RedirectUriKind = 'https' | 'loopback' | 'private-use';

/** Classifies a redirect URI or returns null when policy forbids it. */
export const classifyRedirectUri = (raw: string): RedirectUriKind | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash !== '' || raw.includes('#')) return null;
  if (url.protocol === 'https:') return url.username || url.password ? null : 'https';
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password ? 'loopback' : null;
  }
  return FORBIDDEN_SCHEMES.has(url.protocol) ? null : 'private-use';
};

export const isRedirectUriAllowed = (raw: string): boolean => classifyRedirectUri(raw) !== null;

/** Returns the offending URIs. */
export const findDisallowedRedirectUris = (uris: readonly string[]): string[] =>
  uris.filter((uri) => !isRedirectUriAllowed(uri));

/**
 * `native` when every redirect URI is an http loopback or a private-use scheme, otherwise `web`.
 * (https loopback is not native: oidc-provider rejects it for native clients.)
 */
export const defaultApplicationType = (uris: readonly string[]): 'native' | 'web' => {
  if (uris.length === 0) return 'web';
  const native = uris.every((uri) => {
    const kind = classifyRedirectUri(uri);
    if (kind === 'private-use') return true;
    if (kind === 'loopback') return true;
    return false;
  });
  return native ? 'native' : 'web';
};

export const isCimdHostAllowed = (
  settings: ClientRegistrationSettings,
  clientIdUrl: string,
): boolean => {
  let host: string;
  try {
    host = new URL(clientIdUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (settings.cimdHostAllowlist.length === 0) return true;
  return settings.cimdHostAllowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed;
  });
};

const dcrBody = z
  .object({
    redirect_uris: z.array(z.string()).min(1),
    application_type: z.enum(['native', 'web']).optional(),
  })
  .loose();

export type DcrDecision =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description: string; retryAfter?: number };

/** Pure DCR admission: toggles, rate limit (10 per IP per hour), redirect URIs, application_type default. */
export const admitRegistration = async (input: {
  settings: ClientRegistrationSettings;
  redis: RedisLike;
  ip: string;
  body: unknown;
}): Promise<DcrDecision> => {
  if (!input.settings.dcr) {
    return {
      ok: false,
      status: 403,
      error: 'access_denied',
      description: 'dynamic client registration is disabled',
    };
  }
  const key = `dcr:${input.ip}`;
  const count = await input.redis.incr(key);
  if (count === 1) await input.redis.expire(key, 3600);
  if (count > DCR_LIMIT_PER_HOUR) {
    return {
      ok: false,
      status: 429,
      error: 'access_denied',
      description: 'registration rate limit exceeded',
      retryAfter: 3600,
    };
  }
  const parsed = dcrBody.safeParse(input.body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris is required',
    };
  }
  const bad = findDisallowedRedirectUris(parsed.data.redirect_uris);
  if (bad.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_redirect_uri',
      description: 'redirect URIs must use https, a loopback address or a private-use scheme',
    };
  }
  return {
    ok: true,
    body: {
      ...parsed.data,
      application_type:
        parsed.data.application_type ?? defaultApplicationType(parsed.data.redirect_uris),
    },
  };
};

const MAX_BODY = 64 * 1024;

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
};

export type RegistrationGateOptions = {
  settings: RegistrationSettingsSource;
  redis: RedisLike;
  clientIp: (req: IncomingMessage) => string;
};

/**
 * Intercepts `POST <registration endpoint>` before oidc-provider: admits per policy, then hands the
 * validated body over through `req.body` (oidc-provider accepts an already parsed body).
 * Returns true when the request was fully answered here.
 */
export const gateRegistration = async (
  req: IncomingMessage,
  res: ServerResponse,
  options: RegistrationGateOptions,
): Promise<boolean> => {
  let raw: unknown;
  try {
    const text = await readBody(req);
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    sendJson(res, 400, {
      error: 'invalid_client_metadata',
      error_description: 'invalid JSON body',
    });
    return true;
  }
  const decision = await admitRegistration({
    settings: await options.settings.get(),
    redis: options.redis,
    ip: options.clientIp(req),
    body: raw,
  });
  if (!decision.ok) {
    sendJson(
      res,
      decision.status,
      { error: decision.error, error_description: decision.description },
      decision.retryAfter ? { 'retry-after': String(decision.retryAfter) } : {},
    );
    return true;
  }
  (req as IncomingMessage & { body?: unknown }).body = decision.body;
  return false;
};

/** Default client address: the rightmost `X-Forwarded-For` entry (added by the trusted ingress). */
export const defaultClientIp = (req: IncomingMessage): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = value?.split(',').at(-1)?.trim();
  return last && last.length > 0 ? last : (req.socket.remoteAddress ?? 'unknown');
};

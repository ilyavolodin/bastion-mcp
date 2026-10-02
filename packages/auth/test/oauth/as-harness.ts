import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IdJagVerifier } from '../../src/oauth/as/id-jag-grant';
import { type AuthorizationServer, createAuthorizationServer } from '../../src/oauth/as/server';
import type { ClientRegistrationSettings, PrincipalDirectory } from '../../src/oauth/ports';
import { MemoryOidcModels, MemoryPolicies, MemoryRedis, MemorySigningKeys } from './fakes';

export const HOST = 'bastion.test';
export const ISSUER = `https://${HOST}/oauth`;
const PUBLIC_ORIGIN = `https://${HOST}`;

export type UiBehavior = {
  /** User who logs in when the login interaction is shown. */
  userId: string | null;
  consent: 'approve' | 'deny';
  /** Every consent view the ui rendered (the test asserts the MUST fields). */
  consentViews: unknown[];
  logins: number;
};

export type Harness = {
  as: AuthorizationServer;
  base: string;
  models: MemoryOidcModels;
  keys: MemorySigningKeys;
  policies: MemoryPolicies;
  redis: MemoryRedis;
  settings: ClientRegistrationSettings;
  ui: UiBehavior;
  inactiveUsers: Set<string>;
  serviceAccounts: Map<string, string>;
  fetchLog: string[];
  cimdDocs: Map<string, unknown>;
  idJag: { verifier: IdJagVerifier | undefined };
  close(): Promise<void>;
  browser(): Browser;
};

export type Browser = {
  jar: Map<string, string>;
  /** Follows redirects through the AS and ui until a Location leaves the AS origin. */
  authorize(params: Record<string, string>): Promise<URL>;
  request(url: string, init?: RequestInit): Promise<Response>;
};

export const startHarness = async (overrides: { idJag?: boolean } = {}): Promise<Harness> => {
  const models = new MemoryOidcModels();
  const keys = new MemorySigningKeys();
  keys.add(new Date(Date.now() - 86_400_000), new Date(Date.now() + 40 * 86_400_000));
  const policies = new MemoryPolicies();
  const redis = new MemoryRedis();
  const settings: ClientRegistrationSettings = { cimd: true, dcr: true, cimdHostAllowlist: [] };
  const inactiveUsers = new Set<string>();
  const serviceAccounts = new Map<string, string>();
  const fetchLog: string[] = [];
  const cimdDocs = new Map<string, unknown>();
  const idJag: { verifier: IdJagVerifier | undefined } = { verifier: undefined };
  const principals: PrincipalDirectory = {
    isUserActive: async (id) => !inactiveUsers.has(id),
    serviceAccountForClient: async (clientId) => {
      const id = serviceAccounts.get(clientId);
      return id ? { id } : null;
    },
  };
  const ui: UiBehavior = { userId: 'user-1', consent: 'approve', consentViews: [], logins: 0 };

  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchLog.push(url);
    const doc = cimdDocs.get(url);
    if (!doc) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const as = await createAuthorizationServer({
    host: HOST,
    orgName: 'Acme',
    models,
    signingKeys: keys,
    clientPolicies: policies,
    registration: { get: async () => settings },
    principals,
    redis,
    fetch: fakeFetch,
    onServerError: (e) => console.error('AS server_error', e),
    cookieKeys: [randomBytes(16).toString('hex')],
    ...(overrides.idJag
      ? {
          idJag: {
            verify: (a, e) =>
              idJag.verifier
                ? idJag.verifier.verify(a, e)
                : Promise.reject(new Error('no verifier')),
          },
        }
      : {}),
  });

  const uiHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const view = await as.interactions.view(req, res);
    if (view.kind === 'login') {
      ui.logins += 1;
      if (!ui.userId) return as.interactions.abort(req, res, 'access_denied', 'login failed');
      return as.interactions.completeLogin(req, res, { userId: ui.userId });
    }
    ui.consentViews.push(view.consent);
    if (ui.consent === 'deny') return as.interactions.denyConsent(req, res);
    return as.interactions.completeConsent(req, res);
  };

  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/oauth/interaction/')) {
      uiHandler(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
      return;
    }
    void as.listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const makeBrowser = (): Browser => {
    const jar = new Map<string, string>();
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const local = url.startsWith(PUBLIC_ORIGIN) ? base + url.slice(PUBLIC_ORIGIN.length) : url;
      const headers = new Headers(init.headers);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-host', HOST);
      if (jar.size > 0) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const response = await fetch(local, { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, ...rest] = (pair ?? '').split('=');
        if (!name) continue;
        const value = rest.join('=');
        if (value === '' || /expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const authorize = async (params: Record<string, string>): Promise<URL> => {
      let next = `${ISSUER}/auth?${new URLSearchParams(params).toString()}`;
      for (let hop = 0; hop < 12; hop += 1) {
        const response = await request(next);
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) {
          throw new Error(`unexpected ${response.status}: ${await response.text()}`);
        }
        const absolute = new URL(location, PUBLIC_ORIGIN);
        if (absolute.origin !== PUBLIC_ORIGIN || !absolute.pathname.startsWith('/oauth'))
          return absolute;
        next = absolute.href;
      }
      throw new Error('too many redirects');
    };
    return { jar, authorize, request };
  };

  return {
    as,
    base,
    models,
    keys,
    policies,
    redis,
    settings,
    ui,
    inactiveUsers,
    serviceAccounts,
    fetchLog,
    cimdDocs,
    idJag,
    browser: makeBrowser,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export const tokenRequest = async (
  h: Pick<Harness, 'browser'>,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await h.browser().request(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

export const REDIRECT = 'http://127.0.0.1:8765/callback';

/** Registers a public native client through DCR and returns its id. */
export const registerClient = async (
  h: Harness,
  metadata: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await h.browser().request(`${ISSUER}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

/** Full authorization code + PKCE flow; returns the token response. */
export const codeFlow = async (
  h: Harness,
  clientId: string,
  options: { scope?: string; resource?: string; browser?: Browser; redirectUri?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; callback: URL }> => {
  const browser = options.browser ?? h.browser();
  const { verifier, challenge } = pkcePair();
  const redirectUri = options.redirectUri ?? REDIRECT;
  const callback = await browser.authorize({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: options.scope ?? 'mcp offline_access',
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(options.resource ? { resource: options.resource } : {}),
  });
  const code = callback.searchParams.get('code');
  if (!code) return { status: 400, json: Object.fromEntries(callback.searchParams), callback };
  const token = await tokenRequest(h, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  return { ...token, callback };
};

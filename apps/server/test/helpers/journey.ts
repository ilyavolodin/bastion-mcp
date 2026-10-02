/**
 * Helpers for the end-to-end journeys: IdP seeding, browser sessions through the fake IdP, API calls with the session
 * cookie and CSRF header, and the TS SDK v2 client performing the OAuth 2.1 flow against Bastion's authorization server.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { Infra } from '../../src/infra';
import type { FakeIdp } from './fake-idp';
import { type Browser, makeBrowser, PUBLIC_ORIGIN, proxyFetch } from './ui-harness';

export { PUBLIC_ORIGIN };

/** Registers the fake IdP as the only connection; `bastion-admins` maps to admin. */
export const seedIdp = async (infra: Infra, idp: FakeIdp): Promise<string> => {
  const secret = await infra.secretStore.put(
    { scope: 'org', ownerId: null, name: 'idp:e2e' },
    idp.clientSecret,
  );
  const connection = await infra.repos.idpConnections.create({
    name: 'Acme SSO',
    issuer: idp.issuer,
    discoveryUrl: idp.discoveryUrl,
    clientId: idp.clientId,
    clientSecretId: secret.id,
    scopes: ['openid', 'email', 'profile'],
    emailDomains: [],
    storeRefreshToken: false,
    apiScope: null,
    enterpriseManagedAuth: false,
    enabled: true,
  });
  await infra.repos.roleMappingRules.create({
    idpConnectionId: connection.id,
    groupPattern: 'bastion-admins',
    mapsTo: { orgRole: 'admin' },
    priority: 1,
  });
  return connection.id;
};

/** Logs a person in through the IdP (the fake answers as whoever `behavior` says) and returns the browser. */
export const loginAs = async (
  base: string,
  idp: FakeIdp,
  who: { sub: string; email: string; name: string; groups: string[] },
): Promise<Browser> => {
  Object.assign(idp.behavior, who);
  const b = makeBrowser(base, [idp.issuer]);
  await b.follow(
    `${PUBLIC_ORIGIN}/auth/login?return_to=/`,
    undefined,
    (u) => new URL(u).pathname === '/',
  );
  if (!b.cookie('bastion_sid')) throw new Error('login did not create a session');
  return b;
};

export type ApiResult = { status: number; body: unknown; headers: Headers };

/** Management API call as a browser session: cookie + double-submit CSRF header, `If-Match` when given. */
export const api = async (
  b: Browser,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> => {
  const h: Record<string, string> = { accept: 'application/json', ...headers };
  if (method !== 'GET') {
    h['x-bastion-csrf'] = b.cookie('bastion_csrf') ?? '';
    h['idempotency-key'] = randomBytes(12).toString('hex');
  }
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await b.request(`${PUBLIC_ORIGIN}/api/v1${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body: parsed, headers: res.headers };
};

/** GET then PATCH/DELETE with the current ETag. */
export const withEtag = async (
  b: Browser,
  method: 'PATCH' | 'DELETE' | 'PUT',
  path: string,
  body?: unknown,
): Promise<ApiResult> => {
  const current = await api(b, 'GET', path);
  return api(b, method, path, body, { 'if-match': String(current.headers.get('etag') ?? '*') });
};

export const REDIRECT_URI = 'http://127.0.0.1:8765/callback';

class MemoryOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private info: { client_id: string; client_secret?: string } | undefined;
  private saved: { access_token: string; token_type: string; refresh_token?: string } | undefined;
  private verifier = '';
  readonly clientMetadata = {
    client_name: 'E2E SDK client',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp',
  };
  get redirectUrl() {
    return REDIRECT_URI;
  }
  clientInformation() {
    return this.info as never;
  }
  saveClientInformation(info: never) {
    this.info = info;
  }
  tokens() {
    return this.saved as never;
  }
  saveTokens(tokens: never) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  get accessToken(): string | undefined {
    return this.saved?.access_token;
  }
  get clientId(): string | undefined {
    return this.info?.client_id;
  }
}

export type SdkSession = {
  client: Client;
  accessToken: string;
  clientId: string;
  consentHtml: string | undefined;
};

/**
 * The TS SDK v2 client connects to `/mcp`, is told to authenticate, discovers the protected-resource and AS
 * metadata, registers dynamically (DCR), runs PKCE; the user (a browser logged in through the IdP) consents.
 * Returns a connected client holding the token.
 */
export const connectWithOAuth = async (
  base: string,
  idp: FakeIdp,
  who: { sub: string; email: string; name: string; groups: string[] },
  options: { path?: string; browser?: Browser } = {},
): Promise<SdkSession> => {
  const fetchImpl = proxyFetch(base);
  const provider = new MemoryOAuthProvider();
  const url = new URL(`${PUBLIC_ORIGIN}${options.path ?? '/mcp'}`);
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: provider,
    fetch: fetchImpl,
  });
  const client = new Client({ name: 'e2e-sdk', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    throw new Error('expected the connection to require authorization');
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  const authUrl = provider.authorizationUrl;
  if (!authUrl) throw new Error('no authorization redirect');
  Object.assign(idp.behavior, who);
  const b = options.browser ?? makeBrowser(base, [idp.issuer]);
  let step = await b.follow(authUrl.href);
  if (step.response.status === 200 && step.url.includes('/oauth/interaction/')) {
    const html = await step.response.text();
    const link = /href="(\/auth\/login\?[^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (!link) throw new Error(`no login link in ${html}`);
    step = await b.follow(`${PUBLIC_ORIGIN}${link}`);
  }
  let consentHtml: string | undefined;
  if (step.response.status === 200) {
    consentHtml = await step.response.text();
    const uid = /\/oauth\/interaction\/([^/"]+)\/consent/.exec(consentHtml)?.[1];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(consentHtml)?.[1] ?? '';
    step = await b.follow(`${PUBLIC_ORIGIN}/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, decision: 'approve' }),
    });
  }
  const back = new URL(step.url);
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`no authorization code: ${step.url}`);
  await transport.finishAuth(code, back.searchParams.get('iss') ?? undefined);
  const authed = new StreamableHTTPClientTransport(url, {
    authProvider: provider,
    fetch: fetchImpl,
  });
  const connected = new Client({ name: 'e2e-sdk', version: '1.0.0' }, { capabilities: {} });
  await connected.connect(authed);
  return {
    client: connected,
    accessToken: provider.accessToken ?? '',
    clientId: provider.clientId ?? '',
    consentHtml,
  };
};

/** A client with a bearer token (PAT or a previously obtained access token). */
export const connectWithToken = async (
  base: string,
  token: string,
  options: { era?: 'modern' | 'legacy'; path?: string } = {},
): Promise<Client> => {
  const client = new Client(
    { name: 'e2e-token', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: options.era === 'legacy' ? { mode: 'legacy' } : { mode: 'auto' },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${PUBLIC_ORIGIN}${options.path ?? '/mcp'}`),
    {
      fetch: proxyFetch(base),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  await client.connect(transport);
  return client;
};

export const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

export const eventually = async <T>(
  fn: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 200 } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

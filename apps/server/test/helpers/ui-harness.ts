/**
 * A ui-role harness for the identity routes: real Postgres and Redis (from `createTestEnv`), real infra, auth services
 * and routes on a Fastify app listening on plain HTTP; the public URL is `https://bastion.test` and every request goes
 * through a rewriting fetch (like an ingress terminating TLS).
 */
import { bootstrapAdmin } from '@bastion-mcp/auth';
import type { BastionConfig } from '@bastion-mcp/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthServices } from '../../src/adapters/auth';
import { loadServerConfig, type ServerOptions } from '../../src/config';
import type { AuthServices } from '../../src/contracts';
import { registerAuthRoutes } from '../../src/http/ui';
import { createInfra, type Infra } from '../../src/infra';
import { createTestEnv, type TestEnv } from './env';
import { type FakeIdp, startFakeIdp } from './fake-idp';

export const PUBLIC_ORIGIN = 'https://bastion.test';
export const ADMIN_EMAIL = 'root@acme.example';
export const ADMIN_PASSWORD = 'correct horse battery staple';

export type Browser = {
  jar: Map<string, string>;
  /** One request, no redirect following; cookies are stored and sent. */
  request(url: string, init?: RequestInit): Promise<Response>;
  /** Follows redirects that stay on the public origin; returns the first response that does not or a 2xx/4xx. */
  follow(
    url: string,
    init?: RequestInit,
    stop?: (nextUrl: string) => boolean,
  ): Promise<{ response: Response; url: string }>;
  cookie(name: string): string | undefined;
};

export type UiHarness = {
  env: TestEnv;
  config: BastionConfig;
  infra: Infra;
  auth: AuthServices;
  app: FastifyInstance;
  base: string;
  idp: FakeIdp;
  /** `fetch` for clients (SDK, tests): rewrites the public origin to the local listener. */
  fetch: typeof fetch;
  browser(): Browser;
  close(): Promise<void>;
};

export const proxyFetch =
  (base: string): typeof fetch =>
  (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = raw.startsWith(PUBLIC_ORIGIN) ? base + raw.slice(PUBLIC_ORIGIN.length) : raw;
    const headers = new Headers(init?.headers);
    if (url.startsWith(base)) {
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-host', 'bastion.test');
    }
    return fetch(url, { ...init, headers });
  };

export const makeBrowser = (base: string, followable: string[] = []): Browser => {
  const jar = new Map<string, string>();
  const f = proxyFetch(base);
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (jar.size > 0 && url.startsWith(PUBLIC_ORIGIN)) {
      headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const response = await f(url, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq < 0) continue;
      const name = (pair as string).slice(0, eq).trim();
      const value = (pair as string).slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === '';
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return {
    jar,
    request,
    cookie: (name) => jar.get(name),
    async follow(url, init, stop) {
      let current = url;
      let response = await request(current, init);
      for (let hops = 0; hops < 15; hops++) {
        const location = response.headers.get('location');
        if (!location || response.status < 300 || response.status >= 400) break;
        const next = new URL(location, current).href;
        // Leave when the redirect goes anywhere but the public origin (the client's redirect URI).
        if (![PUBLIC_ORIGIN, ...followable].some((origin) => next.startsWith(origin))) {
          return { response, url: next };
        }
        if (stop?.(next)) return { response, url: next };
        current = next;
        response = await request(current);
      }
      return { response, url: current };
    },
  };
};

export type HarnessOptions = {
  env?: Record<string, string>;
  server?: ServerOptions;
  /** Create the break-glass admin (default true). */
  admin?: boolean;
  /** Register the fake IdP as the only connection and map `bastion-admins` to admin (default false). */
  idpConnection?: boolean;
};

export const startUiHarness = async (options: HarnessOptions = {}): Promise<UiHarness> => {
  const env = await createTestEnv();
  const idp = await startFakeIdp();
  const config = loadServerConfig(
    env.env({
      BASTION_ROLE: 'ui',
      BASTION_PRIVATE_UPSTREAM_CIDRS: '127.0.0.0/8',
      ...options.env,
    }),
  );
  const infra = createInfra(config, { allowInsecureHttp: true, ...options.server });
  if (options.admin !== false) {
    await bootstrapAdmin(
      { users: infra.repos.localAdmins },
      { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    );
  }
  if (options.idpConnection) {
    const secret = await infra.secretStore.put(
      { scope: 'org', ownerId: null, name: 'idp:test' },
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
  }
  const auth = await createAuthServices(infra);
  const app = Fastify({ logger: false, trustProxy: true });
  await registerAuthRoutes(app, { infra, auth });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return {
    env,
    config,
    infra,
    auth,
    app,
    base,
    idp,
    fetch: proxyFetch(base),
    browser: () => makeBrowser(base, [idp.issuer]),
    async close() {
      await app.close();
      await auth.close();
      await infra.close();
      await idp.close();
      await env.cleanup();
    },
  };
};

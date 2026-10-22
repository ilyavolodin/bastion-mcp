import { UpstreamUnavailableError } from '@bastion-mcp/core';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { OutboundDeniedError } from '../../src/oauth/safe-fetch';
import { UpstreamOAuthBroker } from '../../src/oauth/upstream/broker';
import {
  buildUpstreamClientMetadata,
  buildUpstreamJwksDocument,
  buildUpstreamPublicClientMetadata,
  cimdReachable,
  UpstreamClientError,
} from '../../src/oauth/upstream/client-identity';
import {
  discoverUpstream,
  parseChallengeParams,
  UpstreamDiscoveryError,
} from '../../src/oauth/upstream/discovery';
import { UpstreamStateError } from '../../src/oauth/upstream/state';
import {
  HOST,
  safeLoopbackFetch,
  startUpstreamHarness,
  type UpstreamHarness,
  USER,
} from './upstream-harness';

let h: UpstreamHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const start = async (...args: Parameters<typeof startUpstreamHarness>) => {
  h = await startUpstreamHarness(...args);
  return h;
};
const tokenRequests = (x: UpstreamHarness) =>
  x.upstream.requests.filter((r) => r.path === '/token');

describe('9.6 discovery', () => {
  it('9.6 reads resource_metadata from the 401 WWW-Authenticate header', async () => {
    const x = await start();
    const d = await discoverUpstream({ mcpUrl: x.upstream.mcpUrl, fetch: safeLoopbackFetch() });
    expect(d).toMatchObject({
      resource: x.upstream.mcpUrl,
      issuer: x.upstream.origin,
      tokenEndpoint: `${x.upstream.origin}/token`,
      registrationEndpoint: `${x.upstream.origin}/register`,
      scopesSupported: ['read', 'write'],
      issParameterSupported: true,
    });
  });

  it('9.6 falls back to the well-known PRM paths when the 401 names none', async () => {
    const x = await start({ prmInHeader: false });
    const d = await discoverUpstream({ mcpUrl: x.upstream.mcpUrl, fetch: safeLoopbackFetch() });
    expect(d.issuer).toBe(x.upstream.origin);
  });

  it('9.6 fails without protected resource metadata', async () => {
    const x = await start({ prmAvailable: false });
    await expect(
      discoverUpstream({ mcpUrl: x.upstream.mcpUrl, fetch: safeLoopbackFetch() }),
    ).rejects.toMatchObject({
      reason: 'no_protected_resource_metadata',
    });
  });

  it('9.6 MUST refuse to continue when code_challenge_methods_supported lacks S256', async () => {
    const x = await start({ advertiseS256: false });
    await expect(
      discoverUpstream({ mcpUrl: x.upstream.mcpUrl, fetch: safeLoopbackFetch() }),
    ).rejects.toMatchObject({
      reason: 'pkce_s256_required',
    });
    await expect(x.broker.connectPage(x.installation)).rejects.toBeInstanceOf(
      UpstreamDiscoveryError,
    );
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamDiscoveryError,
    );
  });

  it('9.6 refuses an authorization server whose metadata issuer differs from the listed URL', async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('oauth-protected-resource')) {
        return Response.json({
          resource: 'https://up.example/mcp',
          authorization_servers: ['https://as.example'],
        });
      }
      if (url.startsWith('https://as.example/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://evil.example',
          authorization_endpoint: 'https://as.example/a',
          token_endpoint: 'https://as.example/t',
          code_challenge_methods_supported: ['S256'],
        });
      }
      return new Response('', { status: 404 });
    };
    await expect(
      discoverUpstream({ mcpUrl: 'https://up.example/mcp', fetch: fetchStub }),
    ).rejects.toMatchObject({
      reason: 'issuer_mismatch',
    });
  });

  it('9.6 uses OIDC discovery when RFC 8414 metadata is absent, with path-inserted PRM', async () => {
    const seen: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url === 'https://up.example/.well-known/oauth-protected-resource/mcp/e/one') {
        return Response.json({
          resource: 'https://up.example/mcp/e/one',
          authorization_servers: ['https://as.example/tenant'],
        });
      }
      if (url === 'https://as.example/.well-known/openid-configuration/tenant') {
        return Response.json({
          issuer: 'https://as.example/tenant',
          authorization_endpoint: 'https://as.example/a',
          token_endpoint: 'https://as.example/t',
          code_challenge_methods_supported: ['S256'],
        });
      }
      return new Response('', { status: 404 });
    };
    const d = await discoverUpstream({ mcpUrl: 'https://up.example/mcp/e/one', fetch: fetchStub });
    expect(d).toMatchObject({
      issuer: 'https://as.example/tenant',
      resource: 'https://up.example/mcp/e/one',
    });
    expect(seen).toContain('https://as.example/.well-known/oauth-authorization-server/tenant');
  });

  it('9.6 ignores a PRM resource that does not cover the MCP URL', async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('oauth-protected-resource')) {
        return Response.json({
          resource: 'https://other.example/mcp',
          authorization_servers: ['https://as.example'],
        });
      }
      if (url.includes('oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://as.example',
          authorization_endpoint: 'https://as.example/a',
          token_endpoint: 'https://as.example/t',
          code_challenge_methods_supported: ['S256'],
        });
      }
      return new Response('', { status: 404 });
    };
    const d = await discoverUpstream({ mcpUrl: 'https://up.example/mcp', fetch: fetchStub });
    expect(d.resource).toBe('https://up.example/mcp');
  });

  it('9.6 parses WWW-Authenticate challenge parameters', () => {
    expect(
      parseChallengeParams(
        'Bearer realm="x", resource_metadata="https://a/b", error=insufficient_scope, scope="a b"',
      ),
    ).toEqual({
      realm: 'x',
      resource_metadata: 'https://a/b',
      error: 'insufficient_scope',
      scope: 'a b',
    });
    expect(parseChallengeParams(null)).toEqual({});
  });

  it('23.3 discovery never reaches a private address without an admin allowance', async () => {
    const x = await start({}, {}, { outbound: {} });
    await expect(x.broker.connectPage(x.installation)).rejects.toBeInstanceOf(OutboundDeniedError);
  });
});

describe('9.6 client identity', () => {
  it('9.6 preRegistered: uses the admin client with client_secret_basic', async () => {
    const x = await start(
      {},
      {
        client: {
          registration: 'preRegistered',
          clientId: 'gh-app',
          clientSecretRef: 'gh-secret',
          authMethod: 'client_secret_basic',
        },
      },
    );
    await x.secrets.put({ scope: 'org', ownerId: null, name: 'gh-secret' }, 'shh');
    await x.connect();
    const authorize = x.upstream.requests.find((r) => r.path === '/authorize');
    expect(authorize?.params.client_id).toBe('gh-app');
    const token = tokenRequests(x)[0];
    const basic = Buffer.from(
      String(token?.headers.authorization).replace('Basic ', ''),
      'base64',
    ).toString();
    expect(basic.split(':').map(decodeURIComponent)).toEqual(['gh-app', 'shh']);
    expect(x.upstream.registrations).toHaveLength(0);
  });

  it('9.6 preRegistered without its secret is refused', async () => {
    const x = await start(
      {},
      {
        client: {
          registration: 'preRegistered',
          clientId: 'gh-app',
          clientSecretRef: 'missing',
          authMethod: 'client_secret_basic',
        },
      },
    );
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamClientError,
    );
  });

  it('9.6 preRegistered with auth method none needs no secret', async () => {
    const x = await start(
      {},
      { client: { registration: 'preRegistered', clientId: 'public-app', authMethod: 'none' } },
    );
    await x.connect();
    expect(tokenRequests(x)[0]?.headers.authorization).toBeUndefined();
  });

  it('9.6 cimd: client_id is the metadata document URL and token requests use private_key_jwt', async () => {
    const x = await start({ advertiseCimd: true }, { client: { registration: 'cimd' } });
    await x.connect();
    const authorize = x.upstream.requests.find((r) => r.path === '/authorize');
    expect(authorize?.params.client_id).toBe(`https://${HOST}/oauth/upstream/client-metadata.json`);
    const body = tokenRequests(x)[0]?.params;
    expect(body?.client_assertion_type).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const assertion = String(body?.client_assertion);
    expect(decodeProtectedHeader(assertion)).toMatchObject({
      alg: 'ES256',
      kid: x.signingKeys.metas[0]?.kid,
    });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: authorize?.params.client_id,
      aud: x.upstream.origin,
    });
  });

  it('9.6 cimd is refused when the AS does not advertise support', async () => {
    const x = await start({ advertiseCimd: false }, { client: { registration: 'cimd' } });
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamClientError,
    );
  });

  it('9.6 cimd needs an active upstream-client signing key', async () => {
    const x = await start({ advertiseCimd: true }, { client: { registration: 'cimd' } });
    x.signingKeys.metas.length = 0;
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toThrow(/signing key/);
  });

  it('9.6 dcr: registers once as a web client and stores the credentials keyed by issuer', async () => {
    const x = await start();
    await x.connect();
    await x.connect();
    expect(x.upstream.registrations).toHaveLength(1);
    expect(x.upstream.registrations[0]).toMatchObject({
      application_type: 'web',
      redirect_uris: [`https://${HOST}/oauth/upstream/callback`],
      client_name: 'Bastion MCP Gateway (Acme)',
    });
    const row = x.clients.rows.get(x.upstream.origin);
    expect(row).toMatchObject({
      registration: 'dcr',
      clientId: 'dcr-client-1',
      issuer: x.upstream.origin,
    });
    expect(JSON.stringify(row)).not.toContain('dcr-secret-1');
    expect([...x.secrets.byId.values()]).toContain('dcr-secret-1');
  });

  it('9.6 dcr credentials are never reused with another issuer', async () => {
    const x = await start();
    await x.connect();
    const other = await startUpstreamHarness();
    try {
      const sameStore = new UpstreamOAuthBroker({
        ...x.deps,
        installations: {
          get: async () => ({ ...x.installation, upstreamUrl: other.upstream.mcpUrl }),
        },
      });
      await sameStore.startAuthorization(USER, {
        ...x.installation,
        upstreamUrl: other.upstream.mcpUrl,
      });
      expect(other.upstream.registrations).toHaveLength(1);
      expect([...x.clients.rows.keys()].sort()).toEqual(
        [x.upstream.origin, other.upstream.origin].sort(),
      );
      expect(x.clients.rows.get(other.upstream.origin)?.clientId).toBe('dcr-client-1');
    } finally {
      await other.close();
    }
  });

  it('9.6 dcr re-registers when the redirect URI of the stored registration is stale', async () => {
    const x = await start();
    await x.connect();
    const row = x.clients.rows.get(x.upstream.origin);
    if (!row) throw new Error('missing row');
    x.clients.rows.set(row.issuer, {
      ...row,
      metadata: { ...row.metadata, redirect_uris: ['https://old.example/cb'] },
    });
    await x.broker.startAuthorization(USER, x.installation);
    expect(x.upstream.registrations).toHaveLength(2);
  });

  it('9.6 dcr fails when the AS offers no registration endpoint', async () => {
    const x = await start({ registration: false });
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamClientError,
    );
  });

  it('9.6 auto: a pre-registered row for the issuer wins', async () => {
    const x = await start({ advertiseCimd: true }, { client: { registration: 'auto' } });
    x.clients.rows.set(x.upstream.origin, {
      issuer: x.upstream.origin,
      registration: 'preRegistered',
      clientId: 'admin-client',
      clientSecretId: null,
      metadata: { token_endpoint_auth_method: 'none' },
    });
    await x.connect();
    expect(x.upstream.requests.find((r) => r.path === '/authorize')?.params.client_id).toBe(
      'admin-client',
    );
  });

  it('9.6 auto: CIMD when the AS supports it, otherwise DCR', async () => {
    const withCimd = await start({ advertiseCimd: true }, { client: { registration: 'auto' } });
    await withCimd.connect();
    expect(
      withCimd.upstream.requests.find((r) => r.path === '/authorize')?.params.client_id,
    ).toContain('client-metadata.json');
    await withCimd.close();
    const dcr = await startUpstreamHarness(
      { advertiseCimd: false },
      { client: { registration: 'auto' } },
    );
    h = dcr;
    await dcr.connect();
    expect(dcr.upstream.registrations).toHaveLength(1);
  });

  it('9.6 cimd: an AS that lists no private_key_jwt gets the public-client document and no assertion', async () => {
    const x = await start(
      { advertiseCimd: true, authMethods: ['client_secret_basic', 'client_secret_post', 'none'] },
      { client: { registration: 'cimd' } },
    );
    await x.connect();
    const authorize = x.upstream.requests.find((r) => r.path === '/authorize');
    expect(authorize?.params.client_id).toBe(
      `https://${HOST}/oauth/upstream/client-metadata-public.json`,
    );
    const token = tokenRequests(x)[0];
    expect(token?.params.client_assertion).toBeUndefined();
    expect(token?.headers.authorization).toBeUndefined();
  });

  it('9.6 cimd is refused when the AS accepts neither private_key_jwt nor public clients', async () => {
    const x = await start(
      { advertiseCimd: true, authMethods: ['client_secret_basic'] },
      { client: { registration: 'cimd' } },
    );
    await expect(x.broker.startAuthorization(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamClientError,
    );
  });

  it('9.6 auto: falls back to DCR when the AS cannot use a CIMD client', async () => {
    const x = await start(
      { advertiseCimd: true, authMethods: ['client_secret_basic'] },
      { client: { registration: 'auto' } },
    );
    await x.connect();
    expect(x.upstream.registrations).toHaveLength(1);
  });

  it('9.6 auto: an AS that refuses the CIMD client at authorization gets DCR on the retry', async () => {
    const x = await start(
      { advertiseCimd: true, rejectCimdClients: true },
      { client: { registration: 'auto' } },
    );
    await expect(x.connect()).rejects.toMatchObject({ error: 'invalid_client' });
    expect(x.upstream.registrations).toHaveLength(0);
    await x.connect();
    expect(x.upstream.registrations).toHaveLength(1);
    expect(
      x.upstream.requests.filter((r) => r.path === '/authorize').at(-1)?.params.client_id,
    ).toBe('dcr-client-1');
  });

  it('9.6 an explicit cimd registration is not downgraded to DCR after a refusal', async () => {
    const x = await start(
      { advertiseCimd: true, rejectCimdClients: true },
      { client: { registration: 'cimd' } },
    );
    await expect(x.connect()).rejects.toMatchObject({ error: 'invalid_client' });
    await expect(x.connect()).rejects.toMatchObject({ error: 'invalid_client' });
    expect(x.upstream.registrations).toHaveLength(0);
  });

  it('9.6 auto: a local http origin cannot be fetched by the AS, so it registers dynamically', async () => {
    const x = await start({ advertiseCimd: true }, { client: { registration: 'auto' } });
    const local = new UpstreamOAuthBroker({ ...x.deps, host: 'http://localhost:8080' });
    await local.startAuthorization(USER, x.installation);
    expect(x.upstream.registrations).toHaveLength(1);
    expect(x.upstream.registrations[0]).toMatchObject({
      redirect_uris: ['http://localhost:8080/oauth/upstream/callback'],
    });
    const explicit = new UpstreamOAuthBroker({ ...x.deps, host: 'http://localhost:8080' });
    await expect(
      explicit.startAuthorization(USER, {
        ...x.installation,
        auth: { ...x.installation.auth, client: { registration: 'cimd' } },
      }),
    ).rejects.toThrow(/public HTTPS/);
  });

  it('9.6 cimdReachable: only public https origins', () => {
    for (const ok of ['bastion.example.com', 'https://bastion.example.com:8443', 'https://8.8.8.8']) {
      expect(cimdReachable(ok)).toBe(true);
    }
    for (const bad of [
      'http://bastion.example.com',
      'http://localhost:8080',
      'https://localhost',
      'https://bastion.local',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://192.168.0.5',
      'https://172.20.0.1',
      'https://169.254.1.1',
      'https://[::1]',
    ]) {
      expect(cimdReachable(bad)).toBe(false);
    }
  });

  it('9.6 dcr: any 2xx registration response is accepted', async () => {
    const x = await start({ registrationStatus: 202 });
    await x.connect();
    expect(x.upstream.registrations).toHaveLength(1);
  });

  it('9.6 serves the public-client CIMD document', () => {
    expect(buildUpstreamPublicClientMetadata({ host: HOST, orgName: 'Acme' })).toEqual({
      client_id: `https://${HOST}/oauth/upstream/client-metadata-public.json`,
      client_name: 'Bastion MCP Gateway (Acme)',
      redirect_uris: [`https://${HOST}/oauth/upstream/callback`],
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('9.6 serves the CIMD document and the JWKS of the upstream-client keyring', async () => {
    const doc = buildUpstreamClientMetadata({ host: HOST, orgName: 'Acme' });
    expect(doc).toEqual({
      client_id: `https://${HOST}/oauth/upstream/client-metadata.json`,
      client_name: 'Bastion MCP Gateway (Acme)',
      redirect_uris: [`https://${HOST}/oauth/upstream/callback`],
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks_uri: `https://${HOST}/oauth/upstream/jwks`,
    });
    const x = await start();
    const jwks = await buildUpstreamJwksDocument(x.signingKeys, new Date());
    expect(jwks.keys).toHaveLength(1);
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });
});

describe('9.6 authorization and callback', () => {
  it('9.6 the connect page names the upstream AS host and the installation and requires a click', async () => {
    const x = await start();
    expect(await x.broker.connectPage(x.installation)).toEqual({
      installationId: 'inst-1',
      installationName: 'Fake MCP',
      authorizationServerHost: new URL(x.upstream.origin).host,
      authorizationServerIssuer: x.upstream.origin,
      scopes: ['read'],
      requiresClick: true,
    });
  });

  it('9.6 the authorization URL carries PKCE S256, a sealed state, resource and scopes', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${x.upstream.origin}/authorize`);
    const q = url.searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('resource')).toBe(x.upstream.mcpUrl);
    expect(q.get('scope')).toBe('read');
    expect(q.get('redirect_uri')).toBe(`https://${HOST}/oauth/upstream/callback`);
    expect(q.get('response_type')).toBe('code');
    const state = String(q.get('state'));
    expect(state.startsWith('bus1.')).toBe(true);
    expect(state).not.toContain('user-1');
    expect(state).not.toContain('inst-1');
  });

  it('9.6 service accounts cannot use interactive upstream OAuth', async () => {
    const x = await start();
    await expect(
      x.broker.startAuthorization({ type: 'service', id: 'sa-1' }, x.installation),
    ).rejects.toThrow(/service accounts/);
  });

  it('9.6 stores tokens envelope-encrypted, redeems with PKCE and resource, and reports status only', async () => {
    const x = await start();
    await x.connect();
    const token = tokenRequests(x)[0]?.params;
    expect(token).toMatchObject({ grant_type: 'authorization_code', resource: x.upstream.mcpUrl });
    expect(token?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = x.tokens.rows.get('user-1:inst-1');
    expect(row).toMatchObject({
      issuer: x.upstream.origin,
      status: 'valid',
      principalType: 'user',
    });
    expect(row?.scopes).toEqual(['read']);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('up-at-');
    expect(serialized).not.toContain('up-rt-');
    const secret = x.secrets.byId.get(row?.secretId ?? '');
    expect(secret).toContain('up-rt-');
    const status = await x.broker.status('user-1', 'inst-1');
    expect(status).toMatchObject({ status: 'valid', scopes: ['read'], issuer: x.upstream.origin });
    expect(JSON.stringify(status)).not.toContain('up-');
    expect(await x.broker.status('nobody', 'inst-1')).toBeNull();
  });

  it('9.6 / 23.3 a tampered state is rejected', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    const bad = query.replace(/state=bus1\.([^&]{3})/, 'state=bus1.AAA');
    await expect(x.broker.completeAuthorization(USER, bad)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('9.6 / 23.3 an expired state is rejected (10 minutes)', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    x.clock.t += 10 * 60 * 1000 + 1000;
    await expect(x.broker.completeAuthorization(USER, query)).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('9.6 / 23.3 a state replayed by another user is rejected and stores nothing', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    await expect(
      x.broker.completeAuthorization({ type: 'user', id: 'mallory' }, query),
    ).rejects.toMatchObject({
      reason: 'wrong_principal',
    });
    expect(x.tokens.rows.size).toBe(0);
    // The legitimate user can still finish.
    await x.broker.completeAuthorization(USER, query);
    expect(x.tokens.rows.size).toBe(1);
  });

  it('9.6 / 23.3 a state can be used only once', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    await x.broker.completeAuthorization(USER, query);
    await expect(x.broker.completeAuthorization(USER, query)).rejects.toBeInstanceOf(
      UpstreamStateError,
    );
  });

  it('9.6 RFC 9207: an iss that is not the recorded issuer is rejected', async () => {
    const x = await start({ issParameterValue: 'https://mix-up.example' });
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    await expect(x.broker.completeAuthorization(USER, query)).rejects.toThrow(/iss/);
    expect(x.tokens.rows.size).toBe(0);
  });

  it('9.6 RFC 9207: iss is required when the AS advertises support, optional otherwise', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = (await x.upstream.authorize(authorizationUrl)).replace(/&?iss=[^&]+/, '');
    await expect(x.broker.completeAuthorization(USER, query)).rejects.toThrow(/missing iss/);
    const y = await startUpstreamHarness({ issParameter: false });
    try {
      await y.connect();
      expect(y.tokens.rows.size).toBe(1);
    } finally {
      await y.close();
    }
  });

  it('9.6 an authorization error from the upstream is reported without storing anything', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const state = new URL(authorizationUrl).searchParams.get('state');
    await expect(
      x.broker.completeAuthorization(
        USER,
        `error=access_denied&error_description=nope&state=${state}&iss=${x.upstream.origin}`,
      ),
    ).rejects.toMatchObject({ error: 'access_denied', description: 'nope' });
    await expect(x.broker.completeAuthorization(USER, 'code=1')).rejects.toThrow(/missing state/);
  });

  it('9.6 refuses a callback for an installation that no longer exists', async () => {
    const x = await start();
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    const query = await x.upstream.authorize(authorizationUrl);
    x.installations.clear();
    await expect(x.broker.completeAuthorization(USER, query)).rejects.toThrow(/no longer exists/);
  });
});

describe('9.6 refresh', () => {
  it('9.6 returns the stored token while more than 5 minutes remain', async () => {
    const x = await start();
    await x.connect();
    const token = await x.broker.accessToken(USER, x.installation);
    expect(token?.accessToken).toBe('up-at-2');
    expect(tokenRequests(x)).toHaveLength(1);
    expect(x.outcomes).toEqual([]);
  });

  it('9.6 returns null when nothing is stored', async () => {
    const x = await start();
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
  });

  it('9.6 refreshes on use when fewer than 5 minutes remain and records the metric', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += (3600 - 4 * 60) * 1000;
    const token = await x.broker.accessToken(USER, x.installation);
    expect(token?.accessToken).not.toBe('up-at-2');
    expect(tokenRequests(x).at(-1)?.params).toMatchObject({
      grant_type: 'refresh_token',
      resource: x.upstream.mcpUrl,
    });
    expect(x.outcomes).toEqual(['success']);
    expect((await x.upstream.callMcp(token?.accessToken ?? '')).status).toBe(200);
    const again = await x.broker.accessToken(USER, x.installation);
    expect(again?.accessToken).toBe(token?.accessToken);
    expect(tokenRequests(x)).toHaveLength(2);
  });

  it('9.6 refreshes exactly once for concurrent calls (single flight per principal and installation)', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += 3500 * 1000;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => x.broker.accessToken(USER, x.installation)),
    );
    expect(new Set(results.map((r) => r?.accessToken)).size).toBe(1);
    expect(tokenRequests(x).filter((r) => r.params.grant_type === 'refresh_token')).toHaveLength(1);
    expect(x.outcomes).toEqual(['success']);
  });

  it('9.6 a refresh refused by the upstream sets reconnect_required and stops using the token', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += 3500 * 1000;
    x.upstream.behavior.refreshFailure = 'invalid_grant';
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('reconnect_required');
    expect(x.outcomes).toEqual(['reconnect_required']);
    const before = tokenRequests(x).length;
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
    expect(tokenRequests(x)).toHaveLength(before);
    // Reconnecting restores the status.
    await x.connect();
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('valid');
  });

  it('9.6 a transient failure keeps a still-valid token and counts as a failure', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += (3600 - 4 * 60) * 1000;
    x.upstream.behavior.refreshFailure = 'server_error';
    const token = await x.broker.accessToken(USER, x.installation);
    expect(token?.accessToken).toBe('up-at-2');
    expect(x.outcomes).toEqual(['failure']);
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('valid');
  });

  it('9.6 a transient failure after the token expired is an upstream-unavailable error', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += 3700 * 1000;
    x.upstream.behavior.refreshFailure = 'server_error';
    await expect(x.broker.accessToken(USER, x.installation)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('9.6 a token without a refresh token needs a reconnect once it is about to expire', async () => {
    const x = await start();
    await x.connect();
    const secretId = x.tokens.rows.get('user-1:inst-1')?.secretId ?? '';
    x.secrets.byId.set(secretId, JSON.stringify({ accessToken: 'only', refreshToken: null }));
    x.clock.t += 3500 * 1000;
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('reconnect_required');
  });

  it('9.6 tokens are never carried across an issuer change', async () => {
    const x = await start();
    await x.connect();
    const row = x.tokens.rows.get('user-1:inst-1');
    if (!row) throw new Error('missing');
    x.tokens.rows.set('user-1:inst-1', { ...row, issuer: 'https://old-issuer.example' });
    x.clock.t += 3500 * 1000;
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('reconnect_required');
  });

  it('9.6 the daily sweep refreshes tokens that expire within a day', async () => {
    const x = await start({ expiresIn: 3600 });
    await x.connect();
    await x.connect({ type: 'user', id: 'user-2' });
    x.clock.t += 3000 * 1000;
    const result = await x.broker.sweep();
    expect(result).toEqual({ refreshed: 2, reconnectRequired: 0, failed: 0 });
    x.clock.t += 3200 * 1000;
    x.upstream.behavior.refreshFailure = 'invalid_grant';
    expect(await x.broker.sweep()).toEqual({ refreshed: 0, reconnectRequired: 2, failed: 0 });
    x.installations.clear();
    expect(await x.broker.sweep()).toEqual({ refreshed: 0, reconnectRequired: 0, failed: 0 });
  });

  it('9.6 the sweep counts transient failures', async () => {
    const x = await start();
    await x.connect();
    x.clock.t += 3700 * 1000;
    x.upstream.behavior.refreshFailure = 'server_error';
    expect(await x.broker.sweep()).toEqual({ refreshed: 0, reconnectRequired: 0, failed: 1 });
  });
});

describe('9.6 step-up on insufficient_scope', () => {
  it('9.6 a 403 insufficient_scope triggers re-authorization with the union of scopes', async () => {
    const x = await start({ requiredScope: 'write' });
    await x.connect();
    const token = await x.broker.accessToken(USER, x.installation);
    const forbidden = await x.upstream.callMcp(token?.accessToken ?? '');
    expect(forbidden.status).toBe(403);
    const stepUp = await x.broker.handleChallenge(
      USER,
      x.installation,
      forbidden.headers.get('www-authenticate'),
    );
    expect(stepUp).toEqual({
      connectUrl: `https://${HOST}/connect/inst-1`,
      scopes: ['read', 'write'],
    });
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('read write');
    const query = await x.upstream.authorize(authorizationUrl);
    await x.broker.completeAuthorization(USER, query);
    const upgraded = await x.broker.accessToken(USER, x.installation);
    expect(upgraded?.scopes).toEqual(['read', 'write']);
    expect((await x.upstream.callMcp(upgraded?.accessToken ?? '')).status).toBe(200);
    // The pending step-up is cleared.
    const { authorizationUrl: again } = await x.broker.startAuthorization(USER, x.installation);
    expect(new URL(again).searchParams.get('scope')).toBe('read write');
  });

  it('9.6 other challenges do not trigger a step-up', async () => {
    const x = await start();
    expect(
      await x.broker.handleChallenge(USER, x.installation, 'Bearer error="invalid_token"'),
    ).toBeNull();
    expect(await x.broker.handleChallenge(USER, x.installation, null)).toBeNull();
    const noScope = await x.broker.handleChallenge(
      USER,
      x.installation,
      'Bearer error="insufficient_scope"',
    );
    expect(noScope?.scopes).toEqual(['read']);
  });
});

describe('9.1 revocation on deactivation (RFC 7009)', () => {
  it('9.1 revokes access and refresh tokens at the upstream and deletes the local copies', async () => {
    const x = await start();
    await x.connect();
    await x.broker.disconnect(USER, x.installation, 'inst-1');
    expect(x.upstream.revoked).toEqual(['up-rt-2', 'up-at-2']);
    expect(x.tokens.rows.size).toBe(0);
    expect(x.secrets.byId.size).toBe(1); // only the DCR client secret remains
  });

  it('9.1 still deletes locally when the AS has no revocation endpoint or is unreachable', async () => {
    const x = await start({ revocation: false });
    await x.connect();
    await x.broker.disconnect(USER, x.installation, 'inst-1');
    expect(x.upstream.revoked).toEqual([]);
    expect(x.tokens.rows.size).toBe(0);
    await x.connect();
    await x.upstream.close();
    await x.broker.disconnect(USER, x.installation, 'inst-1');
    expect(x.tokens.rows.size).toBe(0);
    x.upstream = await (await import('@bastion-mcp/testkit')).startFakeUpstream();
  });

  it('9.1 disconnectAll removes every installation token of the principal', async () => {
    const x = await start();
    await x.connect();
    const second = { ...x.installation, id: 'inst-2' };
    x.installations.set('inst-2', second);
    await x.connect(USER, second);
    expect(await x.broker.disconnectAll(USER)).toBe(2);
    expect(x.tokens.rows.size).toBe(0);
    expect(await x.broker.disconnectAll(USER)).toBe(0);
  });
});

import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { createOidcAdapterClass } from '../../src/oauth/as/adapter';
import { buildConsentView, redirectUriHostLabel } from '../../src/oauth/as/consent';
import { loadAsJwks } from '../../src/oauth/as/keys';
import {
  classifyRedirectUri,
  defaultApplicationType,
  defaultClientIp,
  isCimdHostAllowed,
} from '../../src/oauth/as/registration';
import { mintTestAccessToken } from '../../src/oauth/test-support';
import {
  buildProtectedResourceMetadata,
  connectUrl,
  isAllowedResource,
} from '../../src/oauth/urls';
import { MemoryOidcModels, MemoryPolicies, MemorySigningKeys } from './fakes';

const HOST = 'bastion.test';

describe('9.3 Protected Resource Metadata', () => {
  it('9.3 builds the document for /mcp', () => {
    expect(buildProtectedResourceMetadata({ host: HOST, orgName: 'Acme' })).toEqual({
      resource: 'https://bastion.test/mcp',
      authorization_servers: ['https://bastion.test/oauth'],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_name: 'Acme MCP',
    });
  });

  it('9.3 path variants return their own URL as the resource', () => {
    const doc = buildProtectedResourceMetadata({
      host: HOST,
      orgName: 'Acme',
      path: '/mcp/e/team',
    });
    expect(doc.resource).toBe('https://bastion.test/mcp/e/team');
  });

  it('9.4 advertises the enterprise-managed authorization extension when enabled', () => {
    const doc = buildProtectedResourceMetadata({
      host: HOST,
      orgName: 'A',
      enterpriseManaged: true,
    });
    expect(doc.extensions_supported).toEqual([
      'io.modelcontextprotocol/enterprise-managed-authorization',
    ]);
  });
});

describe('9.3 resource policy (RFC 8707)', () => {
  it('9.3 property: only /mcp, /mcp/*, and /api on the host are allowed', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https', 'http'] }), (url) => {
        const parsed = new URL(url);
        const expected =
          parsed.protocol === 'https:' &&
          parsed.host === HOST &&
          (parsed.pathname === '/api' ||
            parsed.pathname === '/mcp' ||
            parsed.pathname.startsWith('/mcp/'));
        expect(isAllowedResource(HOST, url)).toBe(expected);
      }),
    );
  });

  it.each([
    ['https://bastion.test/mcp', true],
    ['https://bastion.test/mcp/e/a?x=1', true],
    ['https://bastion.test/api', true],
    ['https://bastion.test/api/v1', false],
    ['https://bastion.test/mcp#f', false],
    ['https://u@bastion.test/mcp', false],
    ['nonsense', false],
  ])('9.3 %s -> %s', (url, expected) => {
    expect(isAllowedResource(HOST, url)).toBe(expected);
  });

  it('6.5 builds the connect URL', () => {
    expect(connectUrl(HOST, 'abc-1')).toBe('https://bastion.test/connect/abc-1');
  });
});

describe('9.3 registration policy helpers', () => {
  it('9.3 classifies redirect URIs (RFC 8252)', () => {
    expect(classifyRedirectUri('https://a.example/cb')).toBe('https');
    expect(classifyRedirectUri('http://[::1]:5/cb')).toBe('loopback');
    expect(classifyRedirectUri('com.example.app:/cb')).toBe('private-use');
    expect(classifyRedirectUri('http://a.example/cb')).toBeNull();
    expect(classifyRedirectUri('data:text/html,x')).toBeNull();
  });

  it('9.3 property: application_type is native only when every URI is http loopback or private-use', () => {
    const uri = fc.constantFrom(
      'http://127.0.0.1:1/cb',
      'cursor://a/b',
      'https://a.example/cb',
      'https://localhost/cb',
    );
    fc.assert(
      fc.property(fc.array(uri, { minLength: 1, maxLength: 4 }), (uris) => {
        const native = uris.every((u) => u.startsWith('http://127') || u.startsWith('cursor:'));
        expect(defaultApplicationType(uris)).toBe(native ? 'native' : 'web');
      }),
    );
    expect(defaultApplicationType([])).toBe('web');
  });

  it('9.3 CIMD allowlist: empty allows any host, entries match exactly or by wildcard', () => {
    const settings = (list: string[]) => ({ cimd: true, dcr: true, cimdHostAllowlist: list });
    expect(isCimdHostAllowed(settings([]), 'https://x.example/a.json')).toBe(true);
    expect(isCimdHostAllowed(settings(['x.example']), 'https://x.example/a.json')).toBe(true);
    expect(isCimdHostAllowed(settings(['x.example']), 'https://y.example/a.json')).toBe(false);
    expect(isCimdHostAllowed(settings(['*.example']), 'https://y.example/a.json')).toBe(true);
    expect(isCimdHostAllowed(settings(['*.example']), 'https://example/a.json')).toBe(false);
    expect(isCimdHostAllowed(settings([]), 'not a url')).toBe(false);
  });

  it('9.3 client IP is the rightmost X-Forwarded-For entry, else the socket address', () => {
    const req = (xff: string | undefined, remote: string | undefined) =>
      ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as never;
    expect(defaultClientIp(req('1.1.1.1, 2.2.2.2', '9.9.9.9'))).toBe('2.2.2.2');
    expect(defaultClientIp(req(undefined, '9.9.9.9'))).toBe('9.9.9.9');
    expect(defaultClientIp(req(undefined, undefined))).toBe('unknown');
  });
});

describe('9.3 consent view', () => {
  it('9.3 labels the redirect URI host, using the scheme for private-use URIs', () => {
    expect(redirectUriHostLabel('https://app.example:8443/cb')).toBe('app.example:8443');
    expect(redirectUriHostLabel('cursor://x/cb')).toBe('x');
    expect(redirectUriHostLabel('com.example:/cb')).toBe('com.example:');
    expect(redirectUriHostLabel('???')).toBe('unknown');
  });

  it('9.3 falls back to the client id for the name and drops non-https logos', () => {
    const view = buildConsentView({
      clientId: 'cid',
      logoUri: 'http://x.example/l.png',
      redirectUri: 'https://a.example/cb',
      scopes: ['mcp'],
      resources: [],
    });
    expect(view).toMatchObject({ clientName: 'cid', logoUri: null, redirectUriHost: 'a.example' });
    expect(
      buildConsentView({ clientId: 'c', logoUri: 5, redirectUri: 'x:', scopes: [], resources: [] })
        .logoUri,
    ).toBeNull();
    expect(
      buildConsentView({
        clientId: 'c',
        logoUri: 'bad',
        redirectUri: 'x:',
        scopes: [],
        resources: [],
      }).logoUri,
    ).toBeNull();
  });
});

describe('9.3 signing keys for the AS', () => {
  it('9.3 loads the newest active key first and keeps old keys until retirement', async () => {
    const keys = new MemorySigningKeys();
    const now = Date.now();
    const old = keys.add(new Date(now - 40 * 86_400_000), new Date(now + 3 * 86_400_000));
    const fresh = keys.add(new Date(now - 1000), new Date(now + 37 * 86_400_000));
    keys.add(new Date(now - 90 * 86_400_000), new Date(now - 60 * 86_400_000));
    keys.add(new Date(now + 86_400_000), new Date(now + 99 * 86_400_000));
    const jwks = await loadAsJwks(keys, now);
    expect(jwks.keys.map((k) => k.kid)).toEqual([fresh, old]);
  });

  it('9.3 fails when no key is active', async () => {
    await expect(loadAsJwks(new MemorySigningKeys(), Date.now())).rejects.toThrow(/no active/);
  });
});

describe('9.3 oidc-provider adapter over oidc_models', () => {
  const setup = (opts: { keyring?: boolean; now?: { t: number } } = {}) => {
    const store = new MemoryOidcModels();
    const clock = { now: () => opts.now?.t ?? Date.now() };
    const policies = new MemoryPolicies();
    const Adapter = createOidcAdapterClass({
      store,
      clock,
      policies,
      ...(opts.keyring
        ? { secretKeyring: { activeKid: 'k', keys: new Map([['k', randomBytes(32)]]) } }
        : {}),
    });
    return { store, Adapter, policies };
  };

  it('9.3 stores grant, uid and user code columns and finds by each', async () => {
    const { Adapter } = setup();
    const a = new Adapter('DeviceCode');
    await a.upsert('id1', { grantId: 'g1', userCode: 'UC', uid: 'u1', x: 1 }, 60);
    expect(await a.find('id1')).toMatchObject({ x: 1 });
    expect(await a.findByUid('u1')).toMatchObject({ x: 1 });
    expect(await a.findByUserCode('UC')).toMatchObject({ x: 1 });
  });

  it('9.3 derives `consumed` from consumed_at and destroys rows', async () => {
    const { Adapter } = setup();
    const a = new Adapter('AuthorizationCode');
    await a.upsert('c1', { grantId: 'g' }, 60);
    await a.consume('c1');
    expect((await a.find('c1'))?.consumed).toBeTypeOf('number');
    await a.destroy('c1');
    expect(await a.find('c1')).toBeUndefined();
  });

  it('9.3 treats rows past expires_at as absent', async () => {
    const now = { t: 1_000_000 };
    const { Adapter } = setup({ now });
    const a = new Adapter('AccessToken');
    await a.upsert('t', { grantId: 'g' }, 10);
    now.t += 11_000;
    expect(await a.find('t')).toBeUndefined();
  });

  it('9.3 revokeByGrantId removes the family', async () => {
    const { Adapter, store } = setup();
    await new Adapter('RefreshToken').upsert('r1', { grantId: 'g' }, 60);
    await new Adapter('AccessToken').upsert('a1', { grantId: 'g' }, 60);
    await new Adapter('RefreshToken').revokeByGrantId('g');
    expect(store.rows.size).toBe(0);
    await new Adapter('Session').revokeByGrantId('g');
  });

  it('22.3 client secrets are sealed at rest and revealed to oidc-provider', async () => {
    const { Adapter, store } = setup({ keyring: true });
    const a = new Adapter('Client');
    await a.upsert('c', { client_id: 'c', client_secret: 'super-secret-value' }, 0);
    expect(JSON.stringify([...store.rows.values()])).not.toContain('super-secret-value');
    expect(await a.find('c')).toMatchObject({ client_secret: 'super-secret-value' });
  });

  it('22.3 a tampered sealed secret is dropped rather than trusted', async () => {
    const { Adapter, store } = setup({ keyring: true });
    const a = new Adapter('Client');
    await a.upsert('c', { client_id: 'c', client_secret: 's3cret' }, 0);
    const row = await store.find('Client', 'c');
    if (row)
      row.payload.client_secret_sealed = `${String(row.payload.client_secret_sealed).slice(0, -3)}AAA`;
    const found = await a.find('c');
    expect(found?.client_secret).toBeUndefined();
  });

  it('9.3 blocked clients are reported unknown', async () => {
    const { Adapter, policies } = setup();
    const a = new Adapter('Client');
    await a.upsert('c', { client_id: 'c' }, 0);
    expect(await a.find('c')).toBeDefined();
    await policies.upsert({ clientId: 'c', preApproved: false, blocked: true }, 'admin');
    expect(await a.find('c')).toBeUndefined();
  });
});

describe('9.3 test support', () => {
  it('mintTestAccessToken produces an RFC 9068 token shaped like the AS output', async () => {
    const keys = new MemorySigningKeys();
    const kid = keys.add(new Date(), new Date(Date.now() + 1e9));
    const jwt = await mintTestAccessToken({
      privateJwk: await keys.loadSigningPrivateKey(kid),
      host: HOST,
      sub: 'u1',
      principalType: 'service',
    });
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid });
    expect(decodeJwt(jwt)).toMatchObject({
      iss: 'https://bastion.test/oauth',
      aud: 'https://bastion.test/mcp',
      sub: 'u1',
      scope: 'mcp',
      'bastion:pt': 'service',
    });
  });
});

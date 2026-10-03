import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdpClients, IdpLogin, type IdpLoginDeps } from '../../src/oauth/idp/login';
import {
  IdpClaimError,
  isEmailDomainAllowed,
  loginScopes,
  mapClaims,
  routeByEmail,
} from '../../src/oauth/idp/profile';
import { testIdpConnection } from '../../src/oauth/idp/test-connection';
import { IdpRefreshError, IdpTokenVault, refreshIdpTokens } from '../../src/oauth/idp/tokens';
import type { IdpConnection } from '../../src/oauth/ports';
import { createSafeFetch } from '../../src/oauth/safe-fetch';
import { type FakeIdp, startFakeIdp } from './fake-idp';
import { MemoryIdpConnections, MemoryIdpTokens, MemorySecrets } from './fakes';

let idp: FakeIdp;
let clockT = Date.now();
const clock = { now: () => clockT };

const connectionFor = (fake: FakeIdp, overrides: Partial<IdpConnection> = {}): IdpConnection => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fake IdP',
  issuer: fake.issuer,
  discoveryUrl: fake.discoveryUrl,
  clientId: fake.clientId,
  clientSecretId: 'secret-1',
  scopes: ['openid', 'email', 'profile'],
  claimMap: { email: 'email', name: 'name', groups: 'groups', sub: 'sub' },
  emailDomains: [],
  storeRefreshToken: false,
  apiScope: null,
  enterpriseManagedAuth: false,
  enabled: true,
  ...overrides,
});

const safe = (fetchFn: typeof fetch = fetch) =>
  createSafeFetch(fetchFn, {
    addressPolicy: { allowCidrs: ['127.0.0.0/8'] },
    allowHttpToAllowedCidrs: true,
  });

const setup = (connection: IdpConnection, fetchFn: typeof fetch = safe()) => {
  const secrets = new MemorySecrets();
  secrets.byId.set('secret-1', idp.clientSecret);
  const connections = new MemoryIdpConnections([connection]);
  const deps: IdpLoginDeps = {
    host: 'bastion.test',
    connections,
    secrets,
    fetch: fetchFn,
    allowInsecureHttp: true,
    clock,
    stateKeyring: { activeKid: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
  };
  return { deps, secrets, login: new IdpLogin(deps), connections };
};

beforeEach(async () => {
  clockT = Date.now();
  idp = await startFakeIdp();
});
afterEach(async () => {
  await idp.close();
});

describe('9.1 OIDC login', () => {
  it('9.1 authorization code + PKCE S256 with state, nonce and the default scopes', async () => {
    const connection = connectionFor(idp);
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id);
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe(idp.issuer);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: `https://bastion.test/auth/callback/${connection.id}`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('9.1 completes the callback, maps claims and returns the IdP tokens', async () => {
    const connection = connectionFor(idp);
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id, { returnTo: '/dashboard' });
    const query = await idp.authorize(start.authorizationUrl);
    const result = await login.completeLogin(connection.id, query, start.stateToken);
    expect(result.profile).toEqual({
      sub: 'idp-user-1',
      email: 'ada@acme.example',
      name: 'Ada Lovelace',
      groups: ['eng', 'bastion-admins'],
      issuer: idp.issuer,
      connectionId: connection.id,
    });
    expect(result.returnTo).toBe('/dashboard');
    expect(result.tokens.accessToken).toMatch(/^idp-at-/);
    expect(result.tokens.idToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeNull();
  });

  it('9.1 requests offline_access when storeRefreshToken is on, and the apiScope', async () => {
    const connection = connectionFor(idp, {
      storeRefreshToken: true,
      apiScope: 'api://bastion/user_impersonation',
    });
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id);
    expect(new URL(start.authorizationUrl).searchParams.get('scope')).toBe(
      'openid email profile offline_access api://bastion/user_impersonation',
    );
    const result = await login.completeLogin(
      connection.id,
      await idp.authorize(start.authorizationUrl),
      start.stateToken,
    );
    expect(result.tokens.refreshToken).toMatch(/^idp-rt-/);
  });

  it('9.1 maps custom claim names through claim_map', async () => {
    idp.behavior.extraClaims = {
      mail: 'Grace@Acme.example',
      displayName: 'Grace H',
      roles: ['ops'],
      uid: 'u-77',
    };
    const connection = connectionFor(idp, {
      claimMap: { email: 'mail', name: 'displayName', groups: 'roles', sub: 'uid' },
    });
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id);
    const result = await login.completeLogin(
      connection.id,
      await idp.authorize(start.authorizationUrl),
      start.stateToken,
    );
    expect(result.profile).toMatchObject({
      sub: 'u-77',
      email: 'grace@acme.example',
      name: 'Grace H',
      groups: ['ops'],
    });
  });

  it('9.1 refuses emails outside the allowed domains', async () => {
    const connection = connectionFor(idp, { emailDomains: ['other.example'] });
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id);
    await expect(
      login.completeLogin(
        connection.id,
        await idp.authorize(start.authorizationUrl),
        start.stateToken,
      ),
    ).rejects.toThrow(/domain/);
  });

  it('9.1 refuses unverified email addresses', async () => {
    idp.behavior.emailVerified = false;
    const connection = connectionFor(idp);
    const { login } = setup(connection);
    const start = await login.startLogin(connection.id);
    await expect(
      login.completeLogin(
        connection.id,
        await idp.authorize(start.authorizationUrl),
        start.stateToken,
      ),
    ).rejects.toThrow(/verified/);
  });

  it('9.1 a disabled connection cannot be used', async () => {
    const connection = connectionFor(idp, { enabled: false });
    const { login } = setup(connection);
    await expect(login.startLogin(connection.id)).rejects.toThrow(/disabled/);
    await expect(login.startLogin('missing')).rejects.toThrow(/unknown/);
  });

  it('9.1 rejects a discovery document whose issuer differs from the connection', async () => {
    const connection = connectionFor(idp, { issuer: 'https://someone-else.example' });
    const { login } = setup(connection);
    await expect(login.startLogin(connection.id)).rejects.toThrow(/issuer/);
  });

  it('9.1 a missing client secret is a configuration error', async () => {
    const connection = connectionFor(idp);
    const { login, secrets } = setup(connection);
    secrets.byId.clear();
    await expect(login.startLogin(connection.id)).rejects.toThrow(/secret/);
  });
});

describe('9.1 / 23.3 login state and issuer checks', () => {
  const started = async () => {
    const connection = connectionFor(idp);
    const ctx = setup(connection);
    const start = await ctx.login.startLogin(connection.id);
    const query = await idp.authorize(start.authorizationUrl);
    return { ...ctx, connection, start, query };
  };

  it('23.3 a tampered state token is rejected', async () => {
    const { login, connection, start, query } = await started();
    const flipped = `${start.stateToken.slice(0, -2)}${start.stateToken.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(login.completeLogin(connection.id, query, flipped)).rejects.toMatchObject({
      reason: 'state',
    });
  });

  it('23.3 an expired state token is rejected', async () => {
    const { login, connection, start, query } = await started();
    clockT += 11 * 60 * 1000;
    await expect(login.completeLogin(connection.id, query, start.stateToken)).rejects.toThrow(
      /expired/,
    );
  });

  it('23.3 the state parameter must match the cookie (login CSRF)', async () => {
    const { login, connection, start, query } = await started();
    const forged = query.replace(/state=[^&]+/, 'state=attacker');
    await expect(login.completeLogin(connection.id, forged, start.stateToken)).rejects.toThrow(
      /mismatch/,
    );
  });

  it('23.3 a state token cannot be replayed against another connection', async () => {
    const { login, connection, start, query, connections } = await started();
    const other = { ...connection, id: '22222222-2222-4222-8222-222222222222' };
    connections.items.push(other);
    await expect(login.completeLogin(other.id, query, start.stateToken)).rejects.toMatchObject({
      reason: 'state',
    });
  });

  it('23.3 a code cannot be redeemed twice (the IdP refuses the second exchange)', async () => {
    const { login, connection, start, query } = await started();
    await login.completeLogin(connection.id, query, start.stateToken);
    await expect(login.completeLogin(connection.id, query, start.stateToken)).rejects.toThrow();
  });

  it('9.1 RFC 9207: an iss that differs from the connection issuer is rejected', async () => {
    idp.behavior.issParameterValue = 'https://mix-up.example';
    const { login, connection, start } = await started();
    const query = await idp.authorize(start.authorizationUrl);
    await expect(login.completeLogin(connection.id, query, start.stateToken)).rejects.toThrow(
      /iss/,
    );
  });

  it('9.1 RFC 9207: iss is required when the IdP advertises support', async () => {
    const { login, connection, start, query } = await started();
    const without = query.replace(/&?iss=[^&]+/, '');
    await expect(login.completeLogin(connection.id, without, start.stateToken)).rejects.toThrow(
      /missing iss/,
    );
  });

  it('9.1 an error response from the IdP fails the login', async () => {
    const { login, connection, start } = await started();
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    await expect(
      login.completeLogin(connection.id, `error=access_denied&state=${state}`, start.stateToken),
    ).rejects.toThrow(/access_denied/);
  });

  it('9.1 a nonce mismatch in the ID token is rejected', async () => {
    const connection = connectionFor(idp);
    const { login, deps } = setup(connection);
    const first = await login.startLogin(connection.id);
    const second = await new IdpLogin(deps).startLogin(connection.id);
    // Code issued for the second request's nonce, state token from the first.
    const query = (await idp.authorize(second.authorizationUrl)).replace(
      /state=[^&]+/,
      `state=${new URL(first.authorizationUrl).searchParams.get('state')}`,
    );
    await expect(login.completeLogin(connection.id, query, first.stateToken)).rejects.toThrow();
  });
});

describe('21.3 / 23.3 SSRF guard on IdP endpoints', () => {
  it('23.3 discovery of a private address is refused unless an admin allows the CIDR', async () => {
    const connection = connectionFor(idp);
    const strict = createSafeFetch(fetch, {});
    const { login } = setup(connection, strict);
    await expect(login.startLogin(connection.id)).rejects.toThrow(/resolves to|https/);
  });
});

describe('9.1 profile mapping and routing', () => {
  const base = connectionFor({ issuer: 'i', discoveryUrl: 'd', clientId: 'c' } as FakeIdp);
  const conn = (id: string, domains: string[], enabled = true): IdpConnection => ({
    ...base,
    id,
    emailDomains: domains,
    enabled,
  });

  it('9.1 routes by email domain when several connections exist', () => {
    const list = [conn('a', ['acme.example']), conn('b', ['beta.example']), conn('c', [])];
    expect(routeByEmail(list, 'x@Acme.example')?.id).toBe('a');
    expect(routeByEmail(list, 'x@beta.example')?.id).toBe('b');
    expect(routeByEmail(list, 'x@gamma.example')?.id).toBe('c');
  });

  it('9.1 routing is ambiguous (null) when several match or when no open connection exists', () => {
    expect(
      routeByEmail([conn('a', ['x.example']), conn('b', ['x.example'])], 'u@x.example'),
    ).toBeNull();
    expect(routeByEmail([conn('a', ['x.example'])], 'u@y.example')).toBeNull();
    expect(routeByEmail([conn('a', ['x.example'], false)], 'u@x.example')).toBeNull();
    expect(routeByEmail([conn('a', []), conn('b', [])], 'u@y.example')).toBeNull();
  });

  it('9.1 property: a routed connection always allows the email domain', () => {
    const domains = fc.constantFrom('a.example', 'b.example', 'c.example');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.array(domains, { maxLength: 2 }), fc.boolean()), {
          minLength: 1,
          maxLength: 4,
        }),
        domains,
        (entries, domain) => {
          const list = entries.map(([d, enabled], i) => conn(`id${i}`, d, enabled));
          const picked = routeByEmail(list, `u@${domain}`);
          if (picked) {
            expect(picked.enabled).toBe(true);
            expect(isEmailDomainAllowed(picked, `u@${domain}`)).toBe(true);
          }
        },
      ),
    );
  });

  it('9.1 default scopes are openid email profile; offline_access and apiScope are added', () => {
    expect(loginScopes({ ...base, scopes: [] })).toEqual(['openid', 'email', 'profile']);
    expect(loginScopes({ ...base, scopes: ['email'] })).toEqual(['openid', 'email']);
    expect(loginScopes({ ...base, storeRefreshToken: true, apiScope: 'a b' })).toEqual([
      'openid',
      'email',
      'profile',
      'offline_access',
      'a',
      'b',
    ]);
  });

  it('9.1 mapClaims reads dotted paths, string groups, and falls back to the email for the name', () => {
    const profile = mapClaims(
      { sub: 's', email: 'a@b.example', realm: { roles: 'solo' } },
      { ...base, claimMap: { email: 'email', name: 'name', groups: 'realm.roles', sub: 'sub' } },
    );
    expect(profile).toMatchObject({ groups: ['solo'], name: 'a@b.example' });
  });

  it('9.1 mapClaims rejects missing sub and malformed email', () => {
    expect(() => mapClaims({ email: 'a@b.example' }, base)).toThrow(IdpClaimError);
    expect(() => mapClaims({ sub: 's', email: 'nope' }, base)).toThrow(/email/);
    expect(mapClaims({ sub: 's', email: 'a@b.example', groups: 5 }, base).groups).toEqual([]);
  });
});

describe('9.7 IdP token storage and refresh', () => {
  const build = async (overrides: Partial<IdpConnection> = {}) => {
    const connection = connectionFor(idp, { storeRefreshToken: true, ...overrides });
    const ctx = setup(connection);
    const store = new MemoryIdpTokens();
    const vault = new IdpTokenVault({ store, secrets: ctx.secrets, clock });
    const clients = new IdpClients(ctx.deps);
    const start = await ctx.login.startLogin(connection.id);
    const result = await ctx.login.completeLogin(
      connection.id,
      await idp.authorize(start.authorizationUrl),
      start.stateToken,
    );
    await vault.save('user-1', connection.id, result.tokens);
    return { ...ctx, connection, store, vault, clients, result };
  };

  it('9.7 stores tokens only inside the encrypted secret store, never in idp_tokens', async () => {
    const { store, secrets, result, connection } = await build();
    const row = store.rows.get(`user-1:${connection.id}`);
    expect(JSON.stringify(row)).not.toContain(result.tokens.accessToken);
    expect(JSON.stringify(row)).not.toContain(String(result.tokens.refreshToken));
    expect(
      [...secrets.byId.values()].some((v) => v.includes(String(result.tokens.refreshToken))),
    ).toBe(true);
    expect(row?.secretId).toBeTruthy();
  });

  it('9.7 returns the stored tokens while they are fresh', async () => {
    const { vault, clients, result, connection } = await build();
    const tokens = await refreshIdpTokens({
      clients,
      vault,
      clock,
      userId: 'user-1',
      connectionId: connection.id,
    });
    expect(tokens.accessToken).toBe(result.tokens.accessToken);
  });

  it('9.7 refreshes when the access token is about to expire and keeps the refresh token', async () => {
    const { vault, clients, result, connection } = await build();
    idp.behavior.rotateRefreshToken = false;
    clockT += 3_590_000;
    const tokens = await refreshIdpTokens({
      clients,
      vault,
      clock,
      userId: 'user-1',
      connectionId: connection.id,
    });
    expect(tokens.accessToken).not.toBe(result.tokens.accessToken);
    expect(tokens.idToken).toBeTruthy();
    expect(tokens.refreshToken).toBe(result.tokens.refreshToken);
    expect((await vault.load('user-1', connection.id))?.accessToken).toBe(tokens.accessToken);
  });

  it('9.7 forceRefresh refreshes a fresh token (to obtain an ID token)', async () => {
    const { vault, clients, result, connection } = await build();
    const tokens = await refreshIdpTokens({
      clients,
      vault,
      clock,
      userId: 'user-1',
      connectionId: connection.id,
      forceRefresh: true,
    });
    expect(tokens.accessToken).not.toBe(result.tokens.accessToken);
  });

  it('9.7 reports a refresh that returns no ID token as idToken null', async () => {
    const { vault, clients, connection } = await build();
    idp.behavior.emitIdTokenOnRefresh = false;
    const tokens = await refreshIdpTokens({
      clients,
      vault,
      clock,
      userId: 'user-1',
      connectionId: connection.id,
      forceRefresh: true,
    });
    expect(tokens.idToken).toBeNull();
  });

  it('9.7 sends the apiScope when refreshing so the Entra access token is renewed', async () => {
    const { vault, clients, connection } = await build({
      apiScope: 'api://bastion/user_impersonation',
    });
    await refreshIdpTokens({
      clients,
      vault,
      clock,
      userId: 'user-1',
      connectionId: connection.id,
      forceRefresh: true,
    });
    const refresh = idp.requests.filter((r) => r.params.grant_type === 'refresh_token').at(-1);
    expect(refresh?.params.scope).toContain('api://bastion/user_impersonation');
  });

  it('9.7 an IdP that revokes the session is reported as refused', async () => {
    const { vault, clients, connection } = await build();
    idp.behavior.refuseRefresh = true;
    await expect(
      refreshIdpTokens({
        clients,
        vault,
        clock,
        userId: 'user-1',
        connectionId: connection.id,
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ kind: 'refused', description: 'refresh token revoked' });
  });

  it('21.3 an unreachable IdP is reported as unavailable', async () => {
    const { vault, clients, connection } = await build();
    await idp.close();
    await expect(
      refreshIdpTokens({
        clients,
        vault,
        clock,
        userId: 'user-1',
        connectionId: connection.id,
        forceRefresh: true,
      }),
    ).rejects.toBeInstanceOf(IdpRefreshError);
    idp = await startFakeIdp();
  });

  it('9.7 no stored session or no refresh token is reported as no_session', async () => {
    const { vault, clients, connection } = await build();
    await expect(
      refreshIdpTokens({ clients, vault, clock, userId: 'nobody', connectionId: connection.id }),
    ).rejects.toMatchObject({ kind: 'no_session' });
    const tokens = await vault.load('user-1', connection.id);
    if (!tokens) throw new Error('missing');
    await vault.save('user-1', connection.id, {
      ...tokens,
      refreshToken: null,
      expiresAt: clockT - 1,
    });
    await expect(
      refreshIdpTokens({ clients, vault, clock, userId: 'user-1', connectionId: connection.id }),
    ).rejects.toMatchObject({ kind: 'no_session' });
    await vault.delete('user-1', connection.id);
    expect(await vault.load('user-1', connection.id)).toBeNull();
  });
});

describe('17.2 idp_connection.test', () => {
  it('17.2 passes when discovery and the JWKS are reachable', async () => {
    const result = await testIdpConnection({
      discoveryUrl: idp.discoveryUrl,
      expectedIssuer: idp.issuer,
      fetch: safe(),
    });
    expect(result).toMatchObject({ ok: true, issuer: idp.issuer, jwksKeyCount: 1 });
    expect(result.checks.map((c) => c.name)).toEqual(['discovery', 'issuer', 'jwks']);
  });

  it('17.2 accepts a bare issuer URL as the discovery URL', async () => {
    const result = await testIdpConnection({
      discoveryUrl: idp.issuer,
      expectedIssuer: idp.issuer,
      fetch: safe(),
    });
    expect(result.ok).toBe(true);
  });

  it('17.2 flags an issuer mismatch', async () => {
    const result = await testIdpConnection({
      discoveryUrl: idp.discoveryUrl,
      expectedIssuer: 'https://x.example',
      fetch: safe(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'issuer')?.ok).toBe(false);
  });

  it('17.2 reports unreachable discovery', async () => {
    const result = await testIdpConnection({
      discoveryUrl: `${idp.issuer}/nope`,
      expectedIssuer: idp.issuer,
      fetch: safe(),
    });
    expect(result).toMatchObject({ ok: false, jwksKeyCount: null });
  });

  it('17.2 reports an unreachable or empty JWKS', async () => {
    const failing: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/jwks')) return new Response('{}', { status: 500 });
      return fetch(input, init);
    };
    const bad = await testIdpConnection({
      discoveryUrl: idp.discoveryUrl,
      expectedIssuer: idp.issuer,
      fetch: safe(failing),
    });
    expect(bad.checks.find((c) => c.name === 'jwks')?.ok).toBe(false);
    const empty: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/jwks')) return new Response('{"keys":[]}', { status: 200 });
      return fetch(input, init);
    };
    const none = await testIdpConnection({
      discoveryUrl: idp.discoveryUrl,
      expectedIssuer: idp.issuer,
      fetch: safe(empty),
    });
    expect(none.checks.find((c) => c.name === 'jwks')).toMatchObject({
      ok: false,
      detail: 'JWKS has no keys',
    });
  });

  it('23.3 refuses to probe a private address without an admin allowance', async () => {
    const result = await testIdpConnection({
      discoveryUrl: idp.discoveryUrl,
      expectedIssuer: idp.issuer,
      fetch: createSafeFetch(fetch, {}),
    });
    expect(result.ok).toBe(false);
  });
});

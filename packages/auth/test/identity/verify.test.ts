import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  generatePatToken,
  hashPatToken,
  InsufficientScopeError,
  TokenVerifier,
} from '../../src/identity';
import {
  FakeClock,
  MemoryKeySource,
  MemoryPats,
  MemoryPrincipals,
  MemoryPubSub,
  MemoryRevocations,
  makeKey,
  memberRecord,
  signAccessToken,
} from './helpers';

const BASE = 'https://bastion.test';
const MCP = `${BASE}/mcp`;

const setup = () => {
  const clock = new FakeClock();
  const keys = new MemoryKeySource();
  const k = makeKey(clock);
  keys.keys = [k.meta];
  const principals = new MemoryPrincipals();
  principals.records.set('user-1', memberRecord('user-1'));
  const revocations = new MemoryRevocations();
  const pats = new MemoryPats();
  const verifier = new TokenVerifier({
    baseUrl: BASE,
    issuer: `${BASE}/oauth`,
    clock,
    keys,
    principals,
    revocations,
    pats,
  });
  return { clock, keys, k, principals, revocations, pats, verifier };
};

type Setup = ReturnType<typeof setup>;

const fail = async (p: Promise<unknown>): Promise<AuthenticationError | InsufficientScopeError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthenticationError || e instanceof InsufficientScopeError) return e;
    throw e;
  }
  throw new Error('expected failure');
};

const addPat = async (s: Setup, over: Record<string, unknown> = {}) => {
  const token = generatePatToken();
  await s.pats.insert({
    id: 'pat-1',
    principalType: 'user',
    principalId: 'user-1',
    name: 'ci',
    tokenSha256: hashPatToken(token),
    scopes: ['mcp'],
    endpointId: null,
    expiresAt: new Date(s.clock.now() + 86_400_000),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(s.clock.now()),
    ...over,
  });
  return token;
};

describe('9.3 access token verification', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it('9.3 accepts a valid JWT and builds the principal', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    const p = await s.verifier.verify(`Bearer ${t}`, MCP);
    expect(p).toMatchObject({
      id: 'user-1',
      authMethod: 'oauth',
      clientId: 'client-1',
      scopes: ['mcp'],
    });
  });

  it('6.9 missing header gives 401 with resource_metadata and scope challenge', async () => {
    const e = await fail(s.verifier.verify(undefined, MCP));
    expect(e.httpStatus).toBe(401);
    expect(e.wwwAuthenticate).toBe(
      'Bearer resource_metadata="https://bastion.test/.well-known/oauth-protected-resource/mcp", scope="mcp"',
    );
  });

  it('6.9 invalid token adds error="invalid_token"', async () => {
    const e = await fail(s.verifier.verify('Bearer garbage', MCP));
    expect(e.httpStatus).toBe(401);
    expect(e.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it('23.3 rejects expired tokens', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    s.clock.advance(16 * 60_000);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('23.3 rejects wrong audience', async () => {
    const t = await signAccessToken(s.k.pair, s.clock, {}, {}, { aud: 'https://other.test/mcp' });
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 accepts an audience that is a path prefix of the request URL', async () => {
    const t = await signAccessToken(s.k.pair, s.clock, {}, {}, { aud: `${MCP}/i/github` });
    await expect(s.verifier.verify(`Bearer ${t}`, `${MCP}/i/github`)).resolves.toBeTruthy();
    await expect(s.verifier.verify(`Bearer ${t}`, `${MCP}/i/githubx`)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(s.verifier.verify(`Bearer ${t}`, `${MCP}/e/other`)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('23.3 rejects wrong issuer', async () => {
    const t = await signAccessToken(s.k.pair, s.clock, {}, {}, { iss: 'https://evil.test/oauth' });
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('23.3 rejects alg none', async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = s.clock.seconds;
    const t = `${enc({ alg: 'none', typ: 'at+jwt' })}.${enc({
      iss: `${BASE}/oauth`,
      sub: 'user-1',
      aud: MCP,
      scope: 'mcp',
      iat,
      exp: iat + 900,
    })}.`;
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('23.3 rejects HS256 confusion (public key bytes as HMAC secret)', async () => {
    const iat = s.clock.seconds;
    const t = await new SignJWT({ scope: 'mcp' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: s.k.pair.kid })
      .setIssuer(`${BASE}/oauth`)
      .setSubject('user-1')
      .setAudience(MCP)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(new TextEncoder().encode(JSON.stringify(s.k.pair.publicJwk)));
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('23.3 rejects wrong typ', async () => {
    const t = await signAccessToken(s.k.pair, s.clock, {}, { typ: 'JWT' });
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('23.3 rejects a tampered payload', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    const [h, p, sig] = t.split('.');
    const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    expect((await fail(s.verifier.verify(`Bearer ${h}.${forged}.${sig}`, MCP))).httpStatus).toBe(
      401,
    );
  });

  it('23.3 rejects a token signed by an unknown key', async () => {
    const other = makeKey(s.clock);
    const t = await signAccessToken(other.pair, s.clock);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 / 23.3 rejects a key past its verification window, even from cache', async () => {
    const t = await signAccessToken(
      s.k.pair,
      s.clock,
      {},
      {},
      { exp: s.clock.seconds + 100 * 86_400 },
    );
    await s.verifier.verify(`Bearer ${t}`, MCP);
    s.clock.advance(38 * 86_400_000);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 revoked: iat not later than the watermark is rejected', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    s.revocations.watermarks.set('user-1', s.clock.seconds);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
    s.clock.advance(5000);
    const t2 = await signAccessToken(s.k.pair, s.clock);
    await expect(s.verifier.verify(`Bearer ${t2}`, MCP)).resolves.toBeTruthy();
  });

  it('9.3 inactive or unknown principal is rejected', async () => {
    s.principals.records.set('user-1', memberRecord('user-1', { active: false }));
    const t = await signAccessToken(s.k.pair, s.clock);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
    s.principals.records.delete('user-1');
    s.verifier.invalidatePrincipal('user-1');
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 rejects a token whose principal type claim disagrees with the record', async () => {
    const t = await signAccessToken(s.k.pair, s.clock, { 'bastion:pt': 'service' });
    expect((await fail(s.verifier.verify(`Bearer ${t}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 principal lookups are cached for 60 s', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    await s.verifier.verify(`Bearer ${t}`, MCP);
    await s.verifier.verify(`Bearer ${t}`, MCP);
    expect(s.principals.lookups).toBe(1);
    s.clock.advance(61_000);
    await s.verifier.verify(`Bearer ${t}`, MCP);
    expect(s.principals.lookups).toBe(2);
  });

  it('4.4 JWKS is cached 10 minutes and reloaded afterwards', async () => {
    const t = await signAccessToken(s.k.pair, s.clock);
    await s.verifier.verify(`Bearer ${t}`, MCP);
    await s.verifier.verify(`Bearer ${t}`, MCP);
    expect(s.keys.loads).toBe(1);
    s.clock.advance(10 * 60_000 + 1);
    const t2 = await signAccessToken(s.k.pair, s.clock);
    await s.verifier.verify(`Bearer ${t2}`, MCP);
    expect(s.keys.loads).toBe(2);
  });

  it('9.3 reloads keys on a bastion:config signing_keys event', async () => {
    const bus = new MemoryPubSub();
    const stop = s.verifier.watchConfigEvents(bus);
    await s.verifier.verify(`Bearer ${await signAccessToken(s.k.pair, s.clock)}`, MCP);
    const fresh = makeKey(s.clock);
    s.keys.keys = [s.k.meta, fresh.meta];
    s.clock.advance(1000);
    await bus.publish('bastion:config', JSON.stringify({ topic: 'signing_keys' }));
    await expect(
      s.verifier.verify(`Bearer ${await signAccessToken(fresh.pair, s.clock)}`, MCP),
    ).resolves.toBeTruthy();
    stop();
  });

  it('9.3 an unknown kid triggers at most one reload per 30 s', async () => {
    const other = makeKey(s.clock);
    const t = await signAccessToken(other.pair, s.clock);
    await fail(s.verifier.verify(`Bearer ${t}`, MCP));
    await fail(s.verifier.verify(`Bearer ${t}`, MCP));
    expect(s.keys.loads).toBe(1);
    s.clock.advance(31_000);
    await fail(s.verifier.verify(`Bearer ${t}`, MCP));
    expect(s.keys.loads).toBe(2);
  });
});

describe('9.3 / 25.6 scope separation', () => {
  it('9.3 plugins:read tokens are accepted only on /plugins/*', async () => {
    const s = setup();
    const t = await signAccessToken(
      s.k.pair,
      s.clock,
      { scope: 'plugins:read' },
      {},
      { aud: `${BASE}/plugins` },
    );
    await expect(
      s.verifier.verify(`Bearer ${t}`, `${BASE}/plugins/acme/marketplace.json`),
    ).resolves.toBeTruthy();
    const mcpAud = await signAccessToken(s.k.pair, s.clock, { scope: 'plugins:read' });
    const e = await fail(s.verifier.verify(`Bearer ${mcpAud}`, MCP));
    expect(e.httpStatus).toBe(403);
    expect(e.wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(e.wwwAuthenticate).toContain('scope="mcp"');
  });

  it('9.3 api scopes only on /api, mcp only on /mcp', async () => {
    const s = setup();
    const api = await signAccessToken(
      s.k.pair,
      s.clock,
      { scope: 'api:read' },
      {},
      { aud: `${BASE}/api` },
    );
    await expect(s.verifier.verify(`Bearer ${api}`, `${BASE}/api/v1/me`)).resolves.toBeTruthy();
    const mcp = await signAccessToken(
      s.k.pair,
      s.clock,
      { scope: 'mcp' },
      {},
      { aud: `${BASE}/api` },
    );
    expect((await fail(s.verifier.verify(`Bearer ${mcp}`, `${BASE}/api/v1/me`))).httpStatus).toBe(
      403,
    );
  });

  it('6.9 unknown surface is refused', async () => {
    const s = setup();
    const t = await signAccessToken(s.k.pair, s.clock);
    expect((await fail(s.verifier.verify(`Bearer ${t}`, `${BASE}/other`))).httpStatus).toBe(403);
  });

  it('9.3 plugin git channel accepts Basic x-access-token:<pat>', async () => {
    const s = setup();
    const token = await addPat(s, { scopes: ['plugins:read'] });
    const basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    await expect(
      s.verifier.verify(basic, `${BASE}/plugins/acme.git/info/refs`),
    ).resolves.toMatchObject({ authMethod: 'pat' });
    const e = await fail(s.verifier.verify(undefined, `${BASE}/plugins/acme.git/info/refs`));
    expect(e.wwwAuthenticate).toBe('Basic realm="Bastion plugins"');
    expect((await fail(s.verifier.verify(basic, MCP))).httpStatus).toBe(401);
    expect((await fail(s.verifier.verify(`Bearer ${token}`, MCP))).httpStatus).toBe(403);
  });
});

describe('9.3 personal access tokens', () => {
  it('9.3 accepts a PAT and exposes scopes and endpoint restriction', async () => {
    const s = setup();
    const token = await addPat(s, { endpointId: 'ep-1' });
    const p = await s.verifier.verify(`Bearer ${token}`, MCP);
    expect(p).toMatchObject({
      id: 'user-1',
      authMethod: 'pat',
      scopes: ['mcp'],
      endpointRestriction: 'ep-1',
      credentialId: 'pat-1',
    });
  });

  it('9.3 rejects malformed, unknown, expired and revoked PATs', async () => {
    const s = setup();
    expect((await fail(s.verifier.verify('Bearer bst_pat_short', MCP))).httpStatus).toBe(401);
    expect((await fail(s.verifier.verify(`Bearer ${generatePatToken()}`, MCP))).httpStatus).toBe(
      401,
    );
    const token = await addPat(s);
    s.clock.advance(2 * 86_400_000);
    expect((await fail(s.verifier.verify(`Bearer ${token}`, MCP))).httpStatus).toBe(401);
    const s2 = setup();
    const t2 = await addPat(s2, { revokedAt: new Date(s2.clock.now()) });
    expect((await fail(s2.verifier.verify(`Bearer ${t2}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 PAT lookups are cached 60 s and revoke events evict the cache', async () => {
    const s = setup();
    const bus = new MemoryPubSub();
    s.verifier.watchRevocations(bus);
    const token = await addPat(s);
    await s.verifier.verify(`Bearer ${token}`, MCP);
    await s.verifier.verify(`Bearer ${token}`, MCP);
    expect(s.pats.lookups).toBe(1);
    await s.pats.markRevoked('pat-1', new Date(s.clock.now()));
    await bus.publish(
      'bastion:revoke',
      JSON.stringify({
        kind: 'pat',
        principalId: 'user-1',
        tokenId: 'pat-1',
        tokenSha256: hashPatToken(token),
      }),
    );
    expect((await fail(s.verifier.verify(`Bearer ${token}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 PATs created before the principal revocation watermark are rejected', async () => {
    const s = setup();
    const token = await addPat(s);
    s.revocations.watermarks.set('user-1', s.clock.seconds + 1);
    expect((await fail(s.verifier.verify(`Bearer ${token}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 last-used updates are batched; inactive principal PAT is rejected', async () => {
    const s = setup();
    const token = await addPat(s);
    await s.verifier.verify(`Bearer ${token}`, MCP);
    await s.verifier.verify(`Bearer ${token}`, MCP);
    expect(s.pats.touched).toHaveLength(0);
    await s.verifier.flushLastUsed();
    expect(s.pats.touched).toHaveLength(1);
    expect(s.pats.touched[0]).toHaveLength(1);
    await s.verifier.flushLastUsed();
    expect(s.pats.touched).toHaveLength(1);
    s.principals.records.set('user-1', memberRecord('user-1', { active: false }));
    s.verifier.invalidatePrincipal('user-1');
    expect((await fail(s.verifier.verify(`Bearer ${token}`, MCP))).httpStatus).toBe(401);
  });

  it('9.3 resolver enforces the endpoint restriction', async () => {
    const s = setup();
    const v = new TokenVerifier({
      baseUrl: BASE,
      issuer: `${BASE}/oauth`,
      clock: s.clock,
      keys: s.keys,
      principals: s.principals,
      revocations: s.revocations,
      pats: s.pats,
      resolveEndpointId: async (u) => (u.pathname.endsWith('/e/a') ? 'ep-a' : null),
    });
    const token = await addPat(s, { endpointId: 'ep-a' });
    await expect(v.verify(`Bearer ${token}`, `${MCP}/e/a`)).resolves.toBeTruthy();
    expect((await fail(v.verify(`Bearer ${token}`, `${MCP}/e/b`))).httpStatus).toBe(403);
  });
});

describe('9.3 deactivated principals', () => {
  it('9.3 a deactivated principal gets invalid_token (401) even with the wrong scope', async () => {
    const s = setup();
    s.principals.records.set('user-1', memberRecord('user-1', { active: false }));
    const jwt = await signAccessToken(s.k.pair, s.clock, { scope: 'plugins:read' });
    const e = await fail(s.verifier.verify(`Bearer ${jwt}`, MCP));
    expect(e.httpStatus).toBe(401);
    expect(e.wwwAuthenticate).toContain('error="invalid_token"');
    const token = await addPat(s, { scopes: ['plugins:read'] });
    const p = await fail(s.verifier.verify(`Bearer ${token}`, MCP));
    expect(p.httpStatus).toBe(401);
  });
});

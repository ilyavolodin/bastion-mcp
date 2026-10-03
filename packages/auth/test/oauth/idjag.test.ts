import { type FakeIdp, startFakeIdp } from '@bastion-mcp/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIdJagVerifier, MemoryJtiGuard } from '../../src/oauth/idp/id-jag';
import type { IdpConnection } from '../../src/oauth/ports';
import { createSafeFetch } from '../../src/oauth/safe-fetch';
import { MemoryIdpConnections } from './fakes';

let idp: FakeIdp;
let nowMs = Date.now();
const AUD = 'https://bastion.test/oauth';
const RESOURCE = 'https://bastion.test/mcp';
const CLIENT = 'client-1';

const connection = (overrides: Partial<IdpConnection> = {}): IdpConnection => ({
  id: 'conn-1',
  name: 'IdP',
  issuer: idp.issuer,
  discoveryUrl: idp.discoveryUrl,
  clientId: idp.clientId,
  clientSecretId: 's',
  scopes: [],
  claimMap: { email: 'email', name: 'name', groups: 'groups', sub: 'sub' },
  emailDomains: [],
  storeRefreshToken: false,
  apiScope: null,
  enterpriseManagedAuth: true,
  redirectToRoot: false,
  enabled: true,
  ...overrides,
});

const verifier = (
  conns: IdpConnection[],
  resolve: (sub: string) => string | null = (s) => `user-for-${s}`,
) =>
  createIdJagVerifier({
    connections: new MemoryIdpConnections(conns),
    fetch: createSafeFetch(fetch, {
      addressPolicy: { allowCidrs: ['127.0.0.0/8'] },
      allowHttpToAllowedCidrs: true,
    }),
    clock: { now: () => nowMs },
    resolveUser: async (_c, claims) => {
      const id = resolve(claims.sub);
      return id ? { userId: id } : null;
    },
  });

const jag = (
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { typ: 'oauth-id-jag+jwt' },
) => {
  const iat = Math.floor(nowMs / 1000);
  return idp.sign(
    {
      iss: idp.issuer,
      sub: 'idp-user-1',
      aud: AUD,
      resource: RESOURCE,
      client_id: CLIENT,
      jti: crypto.randomUUID(),
      iat,
      exp: iat + 300,
      ...claims,
    },
    header,
  );
};
const expectation = { audience: AUD, resource: RESOURCE, clientId: CLIENT };

beforeEach(async () => {
  nowMs = Date.now();
  idp = await startFakeIdp();
});
afterEach(async () => {
  await idp.close();
});

describe('9.4 ID-JAG verification', () => {
  it('9.4 accepts a valid ID-JAG and maps sub to a user', async () => {
    const v = verifier([connection()]);
    await expect(v.verify(await jag(), expectation)).resolves.toEqual({
      userId: 'user-for-idp-user-1',
    });
  });

  it('9.4 accepts a resource array containing the requested resource', async () => {
    const v = verifier([connection()]);
    await expect(
      v.verify(await jag({ resource: ['https://x.example', RESOURCE] }), expectation),
    ).resolves.toBeTruthy();
  });

  it.each([
    ['iss from an unknown issuer', { iss: 'https://other.example' }, /no IdP connection/],
    ['aud for another AS', { aud: 'https://evil.example/oauth' }, /invalid/],
    ['resource for another URL', { resource: 'https://bastion.test/api' }, /resource/],
    ['client_id of another client', { client_id: 'other-client' }, /client_id/],
    ['missing client_id', { client_id: undefined }, /missing required claims/],
    ['missing jti', { jti: undefined }, /missing required claims/],
  ])('9.4 rejects an ID-JAG with %s', async (_name, claims, message) => {
    const v = verifier([connection()]);
    await expect(v.verify(await jag(claims), expectation)).rejects.toThrow(message);
  });

  it('9.4 rejects an expired ID-JAG', async () => {
    const v = verifier([connection()]);
    const token = await jag({ exp: Math.floor(nowMs / 1000) - 120 });
    await expect(v.verify(token, expectation)).rejects.toThrow(/invalid/);
  });

  it('9.4 rejects an ID-JAG signed by a different key', async () => {
    const other = await startFakeIdp();
    try {
      const forged = await other.sign({
        iss: idp.issuer,
        sub: 's',
        aud: AUD,
        resource: RESOURCE,
        client_id: CLIENT,
        jti: 'j',
        exp: Math.floor(nowMs / 1000) + 300,
      });
      await expect(verifier([connection()]).verify(forged, expectation)).rejects.toThrow(/invalid/);
    } finally {
      await other.close();
    }
  });

  it('23.3 rejects alg none and non-JWT input', async () => {
    const v = verifier([connection()]);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: AUD })).toString('base64url');
    await expect(v.verify(`${header}.${body}.`, expectation)).rejects.toThrow();
    await expect(v.verify('garbage', expectation)).rejects.toThrow(/not a JWT/);
  });

  it('9.4 rejects access-token typed assertions', async () => {
    const v = verifier([connection()]);
    await expect(v.verify(await jag({}, { typ: 'at+jwt' }), expectation)).rejects.toThrow(/type/);
  });

  it('9.4 requires the connection to have enterprise-managed authorization enabled', async () => {
    await expect(
      verifier([connection({ enterpriseManagedAuth: false })]).verify(await jag(), expectation),
    ).rejects.toThrow(/no IdP connection/);
    await expect(
      verifier([connection({ enabled: false })]).verify(await jag(), expectation),
    ).rejects.toThrow(/no IdP connection/);
  });

  it('9.4 an ID-JAG can be used only once (jti replay)', async () => {
    const v = verifier([connection()]);
    const token = await jag();
    await v.verify(token, expectation);
    await expect(v.verify(token, expectation)).rejects.toThrow(/already used/);
  });

  it('9.4 picks up a rotated IdP signing key by refetching the JWKS once', async () => {
    const v = verifier([connection()]);
    await v.verify(await jag(), expectation);
    await idp.rotateKey();
    await expect(v.verify(await jag(), expectation)).resolves.toBeTruthy();
  });

  it('9.4 refuses when the subject maps to no Bastion user', async () => {
    const v = verifier([connection()], () => null);
    await expect(v.verify(await jag(), expectation)).rejects.toThrow(/not a Bastion user/);
  });

  it('9.4 the in-memory jti guard forgets entries after their ttl', async () => {
    let t = 0;
    const guard = new MemoryJtiGuard({ now: () => t });
    expect(await guard.consume('a', 10)).toBe(true);
    expect(await guard.consume('a', 10)).toBe(false);
    t = 11_000;
    expect(await guard.consume('a', 10)).toBe(true);
  });

  it('21.3 reports an unreachable IdP JWKS as an invalid assertion', async () => {
    const v = verifier([connection()]);
    const token = await jag();
    await idp.close();
    await expect(v.verify(token, expectation)).rejects.toThrow();
    idp = await startFakeIdp();
  });
});

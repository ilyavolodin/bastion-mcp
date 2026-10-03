import { BastionError, UI_CLIENT_ID } from '@bastion-mcp/core';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  effectiveSlugOf,
  mintAccessToken,
  principalFor,
} from '../src/adapters/gateway-client';
import { fakeInfra, manualClock } from './fake-infra';

type SigningKey = { kid: string; activeFrom: Date; retireAfter: Date };

const NOW = Date.parse('2026-03-01T12:00:00Z');
const minutes = (n: number) => n * 60_000;

describe('9.6 mintAccessToken', () => {
  let privateJwk: Awaited<ReturnType<typeof exportJWK>>;
  let publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateJwk = await exportJWK(pair.privateKey);
    publicKey = pair.publicKey;
  });

  const harness = (keys: SigningKey[]) => {
    const loaded: string[] = [];
    const infra = fakeInfra({
      clock: manualClock(NOW),
      config: { urls: { issuer: 'https://bastion.test/oauth' }, publicUrl: 'https://bastion.test' },
    });
    const auth = {
      keyStore: {
        listSigningKeys: async () => keys,
        loadSigningPrivateKey: async (kid: string) => {
          loaded.push(kid);
          return privateJwk;
        },
      },
    };
    // The method set the code under test calls; the rest of KeyStore is not used.
    return { infra, auth: auth as never as Parameters<typeof mintAccessToken>[1], loaded };
  };

  it('signs a 60 s user token from the injected clock with the newest active key', async () => {
    const h = harness([
      {
        kid: 'old',
        activeFrom: new Date(NOW - minutes(60)),
        retireAfter: new Date(NOW + minutes(60)),
      },
      {
        kid: 'new',
        activeFrom: new Date(NOW - minutes(5)),
        retireAfter: new Date(NOW + minutes(60)),
      },
      {
        kid: 'future',
        activeFrom: new Date(NOW + minutes(5)),
        retireAfter: new Date(NOW + minutes(90)),
      },
      {
        kid: 'retired',
        activeFrom: new Date(NOW - minutes(90)),
        retireAfter: new Date(NOW - minutes(1)),
      },
    ]);
    const token = await mintAccessToken(h.infra, h.auth, 'user-1');
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: 'https://bastion.test/mcp',
      issuer: 'https://bastion.test/oauth',
      currentDate: new Date(NOW),
    });
    expect(h.loaded).toEqual(['new']);
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'new', typ: 'at+jwt' });
    expect(payload.sub).toBe('user-1');
    expect(payload.client_id).toBe(UI_CLIENT_ID);
    expect(payload.scope).toBe('mcp');
    expect(payload['bastion:pt']).toBe('user');
    expect(payload.iat).toBe(NOW / 1000);
    expect(payload.exp).toBe(NOW / 1000 + ACCESS_TOKEN_TTL_SECONDS);
    expect(typeof payload.jti).toBe('string');
  });

  it('gives every token its own jti', async () => {
    const h = harness([
      { kid: 'k', activeFrom: new Date(NOW - minutes(5)), retireAfter: new Date(NOW + minutes(5)) },
    ]);
    const a = await jwtVerify(await mintAccessToken(h.infra, h.auth, 'u'), publicKey, {
      currentDate: new Date(NOW),
    });
    const b = await jwtVerify(await mintAccessToken(h.infra, h.auth, 'u'), publicKey, {
      currentDate: new Date(NOW),
    });
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it('refuses when no signing key is usable now', async () => {
    const h = harness([
      {
        kid: 'future',
        activeFrom: new Date(NOW + minutes(5)),
        retireAfter: new Date(NOW + minutes(90)),
      },
    ]);
    await expect(mintAccessToken(h.infra, h.auth, 'u')).rejects.toThrow('no usable signing key');
  });
});

describe('9.6 principalFor', () => {
  const store = (record: object | null) =>
    ({ principalStore: { getPrincipal: async () => record } }) as never as Parameters<
      typeof principalFor
    >[0];

  it('refuses an unknown or inactive principal with 403', async () => {
    for (const record of [null, { id: 'u', active: false }]) {
      const error = await principalFor(store(record), 'u').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BastionError);
      expect((error as BastionError).httpStatus).toBe(403);
    }
  });
});

describe('7.1 effectiveSlugOf', () => {
  const infraWith = (installation: object | null, team: object | null) =>
    fakeInfra({
      db: {
        prisma: {
          installation: { findUnique: async () => installation },
          team: { findUnique: async () => team },
        },
      },
    });

  it('uses the plain slug for user installations', async () => {
    const infra = infraWith({ slug: 'github', ownerType: 'user', ownerId: 'u' }, null);
    expect(await effectiveSlugOf(infra, 'i')).toBe('github');
  });

  it('prefixes team installations with the team slug', async () => {
    const infra = infraWith(
      { slug: 'github', ownerType: 'team', ownerId: 't' },
      { slug: 'platform' },
    );
    expect(await effectiveSlugOf(infra, 'i')).toBe('platform-github');
  });

  it('falls back to the plain slug when the team is gone', async () => {
    const infra = infraWith({ slug: 'github', ownerType: 'team', ownerId: 't' }, null);
    expect(await effectiveSlugOf(infra, 'i')).toBe('github');
  });

  it('answers 404 for an unknown installation', async () => {
    const error = await effectiveSlugOf(infraWith(null, null), 'i').catch((e: unknown) => e);
    expect((error as BastionError).httpStatus).toBe(404);
  });
});

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { openJson, sealJson } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  buildJwks,
  buildStateKeyring,
  generateEs256KeyPair,
  generateStateKey,
  type KeyStore,
  planRotation,
  ROTATION_POLICIES,
  retireAfterFor,
  rotateKeyring,
  type SigningKeyMeta,
  type StateKeyMaterial,
  stateKeySecretName,
} from '../src';
import { FakeClock } from './helpers';

const DAY = 86_400_000;
const T0 = new Date(Date.UTC(2026, 0, 1));
const key = (kid: string, from: Date, policy = ROTATION_POLICIES.as) => ({
  kid,
  activeFrom: from,
  retireAfter: retireAfterFor(from, policy),
});

describe('key generation', () => {
  it('22.3 generates ES256 pairs that sign and verify, with a thumbprint kid', () => {
    const pair = generateEs256KeyPair();
    expect(pair.alg).toBe('ES256');
    expect(pair.publicJwk.crv).toBe('P-256');
    expect(pair.publicJwk.d).toBeUndefined();
    expect(pair.privateJwk.d).toBeDefined();
    expect(pair.kid).not.toBe(generateEs256KeyPair().kid);
    const priv = createPrivateKey({ key: pair.privateJwk, format: 'jwk' });
    const pub = createPublicKey({ key: pair.publicJwk, format: 'jwk' });
    const sig = sign('sha256', Buffer.from('m'), { key: priv, dsaEncoding: 'ieee-p1363' });
    expect(verify('sha256', Buffer.from('m'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(
      true,
    );
  });

  it('22.3 state keys are 256-bit with a dot-free prefixed kid', () => {
    const k = generateStateKey();
    expect(k.key).toHaveLength(32);
    expect(k.kid).toMatch(/^st_[A-Za-z0-9_-]+$/);
    expect(stateKeySecretName(k.kid)).toBe(`state:${k.kid}`);
  });
});

describe('planRotation', () => {
  it('22.3 creates the first key when none exists', () => {
    expect(planRotation([], T0, ROTATION_POLICIES.as)).toEqual({
      create: true,
      retire: [],
      activeKid: undefined,
    });
  });

  it('22.3 as keys rotate every 30 days and verify 7 more days', () => {
    const k = key('a', T0);
    const policy = ROTATION_POLICIES.as;
    const at = (days: number) => planRotation([k], new Date(T0.getTime() + days * DAY), policy);
    expect(at(29).create).toBe(false);
    expect(at(30).create).toBe(true);
    expect(at(36).retire).toEqual([]);
    expect(at(37).retire).toEqual(['a']);
    expect(at(10).activeKid).toBe('a');
  });

  it('22.3 upstream-client keys rotate every 90 days', () => {
    const policy = ROTATION_POLICIES['upstream-client'];
    const k = key('u', T0, policy);
    expect(planRotation([k], new Date(T0.getTime() + 89 * DAY), policy).create).toBe(false);
    expect(planRotation([k], new Date(T0.getTime() + 90 * DAY), policy).create).toBe(true);
  });

  it('22.3 ignores keys whose activeFrom is in the future', () => {
    const future = key('f', new Date(T0.getTime() + DAY));
    expect(planRotation([future], T0, ROTATION_POLICIES.as).create).toBe(true);
  });

  it('22.3 picks the newest key as active and retires only expired ones', () => {
    const old = key('old', new Date(T0.getTime() - 40 * DAY));
    const mid = key('mid', new Date(T0.getTime() - 10 * DAY));
    const plan = planRotation([old, mid], T0, ROTATION_POLICIES.as);
    expect(plan).toEqual({ create: false, retire: ['old'], activeKid: 'mid' });
  });
});

describe('state keyring', () => {
  const policy = ROTATION_POLICIES.state;
  const mk = (daysAgo: number): StateKeyMaterial => ({
    ...generateStateKey(),
    ...key(`x`, new Date(T0.getTime() - daysAgo * DAY), policy),
  });

  it('22.3 active key is the newest; the previous two days still decrypt', () => {
    const [d0, d1, d2, d3] = [0, 1, 2, 3].map((n) => ({ ...mk(n), kid: `st_${n}` }));
    const ring = buildStateKeyring([d3, d2, d1, d0] as StateKeyMaterial[], T0);
    expect(ring.activeKid).toBe('st_0');
    expect([...ring.keys.keys()].sort()).toEqual(['st_0', 'st_1', 'st_2']);
  });

  it('22.3 a token sealed with yesterday key opens, and one from 3 days ago does not', () => {
    const yesterday = { ...mk(1), kid: 'st_y' };
    const today = { ...mk(0), kid: 'st_t' };
    const ancient = { ...mk(3), kid: 'st_a' };
    const oldRing = buildStateKeyring([yesterday], new Date(T0.getTime() - DAY + 1));
    const token = sealJson({ a: 1 }, oldRing, { prefix: 'rs1.' });
    const ring = buildStateKeyring([ancient, yesterday, today], T0);
    expect(openJson(token, ring, { prefix: 'rs1.' })).toEqual({ a: 1 });
    expect(ring.keys.has('st_a')).toBe(false);
  });

  it('22.3 throws when no key is usable', () => {
    expect(() => buildStateKeyring([], T0)).toThrow(/rotate/);
  });
});

class MemoryKeyStore implements KeyStore {
  signing: (SigningKeyMeta & { priv: Record<string, string> })[] = [];
  state: StateKeyMaterial[] = [];
  async listSigningKeys(purpose: 'as' | 'upstream-client') {
    return this.signing.filter((k) => k.purpose === purpose);
  }
  async addSigningKey(meta: SigningKeyMeta, priv: Record<string, string>) {
    this.signing.push({ ...meta, priv });
  }
  async loadSigningPrivateKey(kid: string) {
    return this.signing.find((k) => k.kid === kid)?.priv ?? {};
  }
  async deleteSigningKeys(kids: string[]) {
    this.signing = this.signing.filter((k) => !kids.includes(k.kid));
  }
  async listStateKeys() {
    return this.state;
  }
  async addStateKey(k: StateKeyMaterial) {
    this.state.push(k);
  }
  async deleteStateKeys(kids: string[]) {
    this.state = this.state.filter((k) => !kids.includes(k.kid));
  }
}

describe('rotateKeyring', () => {
  it('22.3 rotates the state keyring daily and drops keys after 3 days', async () => {
    const store = new MemoryKeyStore();
    const clock = new FakeClock();
    const first = await rotateKeyring(store, 'state', clock);
    expect(first.created).toBeDefined();
    expect((await rotateKeyring(store, 'state', clock)).created).toBeUndefined();
    for (let d = 0; d < 4; d++) {
      clock.advance(DAY);
      await rotateKeyring(store, 'state', clock);
    }
    expect(store.state.length).toBeLessThanOrEqual(3);
    expect(store.state.length).toBeGreaterThanOrEqual(2);
    const ring = buildStateKeyring(store.state, new Date(clock.now()));
    expect(ring.keys.has(first.created ?? '')).toBe(false);
  });

  it('22.3 rotates as keys every 30 days and keeps the old one verifying for 7 days', async () => {
    const store = new MemoryKeyStore();
    const clock = new FakeClock();
    const a = (await rotateKeyring(store, 'as', clock)).created;
    clock.advance(30 * DAY);
    const b = (await rotateKeyring(store, 'as', clock)).created;
    expect(b).toBeDefined();
    const jwks = buildJwks(store.signing, new Date(clock.now()));
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([a, b].sort());
    clock.advance(7 * DAY);
    const out = await rotateKeyring(store, 'as', clock);
    expect(out.retired).toEqual([a]);
    expect(store.signing.map((k) => k.kid)).toEqual([b]);
    expect(buildJwks(store.signing, new Date(clock.now())).keys).toHaveLength(1);
    expect(Object.keys(await store.loadSigningPrivateKey(b ?? ''))).toContain('d');
  });

  it('22.3 keeps upstream-client and as keyrings separate', async () => {
    const store = new MemoryKeyStore();
    const clock = new FakeClock();
    await rotateKeyring(store, 'upstream-client', clock);
    expect(await store.listSigningKeys('as')).toHaveLength(0);
    expect(await store.listSigningKeys('upstream-client')).toHaveLength(1);
  });
});

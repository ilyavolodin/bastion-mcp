import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AeadError, type Keyring, openJson, sealJson } from '../src/aead';

const keyring = (kids: string[], active = kids[0] as string): Keyring => ({
  activeKid: active,
  keys: new Map(kids.map((k) => [k, randomBytes(32)])),
});

describe('22.3 AEAD tokens (AES-256-GCM, kid-prefixed)', () => {
  it('round-trips JSON payloads', () => {
    const ring = keyring(['k1']);
    const token = sealJson({ a: 1, b: 'x' }, ring, { prefix: 'bst1.' });
    expect(token.startsWith('bst1.')).toBe(true);
    expect(openJson(token, ring, { prefix: 'bst1.' })).toEqual({ a: 1, b: 'x' });
  });

  it('property: arbitrary JSON survives a round trip', () => {
    const ring = keyring(['k1']);
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const token = sealJson(v, ring, { prefix: 'p.' });
        return JSON.stringify(openJson(token, ring, { prefix: 'p.' })) === JSON.stringify(v);
      }),
    );
  });

  it('rejects tampered tokens', () => {
    const ring = keyring(['k1']);
    const token = sealJson({ a: 1 }, ring, { prefix: 'p.' });
    const bad = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => openJson(bad, ring, { prefix: 'p.' })).toThrow(AeadError);
  });

  it('rejects a wrong prefix and a wrong aad', () => {
    const ring = keyring(['k1']);
    const token = sealJson({ a: 1 }, ring, { prefix: 'p.', aad: 'one' });
    expect(() => openJson(token, ring, { prefix: 'q.', aad: 'one' })).toThrow(AeadError);
    expect(() => openJson(token, ring, { prefix: 'p.', aad: 'two' })).toThrow(AeadError);
  });

  it('opens tokens sealed with a previous key still in the ring and seals with the active one', () => {
    const oldRing = keyring(['old']);
    const token = sealJson({ n: 1 }, oldRing, { prefix: 'p.' });
    const ring: Keyring = {
      activeKid: 'new',
      keys: new Map([
        ['new', randomBytes(32)],
        ['old', oldRing.keys.get('old') as Buffer],
      ]),
    };
    expect(openJson(token, ring, { prefix: 'p.' })).toEqual({ n: 1 });
    expect(sealJson({}, ring, { prefix: 'p.' }).startsWith('p.new.')).toBe(true);
  });

  it('rejects tokens sealed with a key that left the ring', () => {
    const token = sealJson({ n: 1 }, keyring(['gone']), { prefix: 'p.' });
    expect(() => openJson(token, keyring(['other']), { prefix: 'p.' })).toThrow(AeadError);
  });

  it('requires 32-byte keys', () => {
    const bad: Keyring = { activeKid: 'k', keys: new Map([['k', randomBytes(16)]]) };
    expect(() => sealJson({}, bad, { prefix: 'p.' })).toThrow(AeadError);
  });
});

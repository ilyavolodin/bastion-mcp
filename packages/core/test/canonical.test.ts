import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, canonicalJson, sha256, sha256Hex } from '../src/canonical';

describe('13.6 canonical hashing (RFC 8785)', () => {
  it('serializes with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('digest is independent of key order', () => {
    expect(canonicalDigest({ a: 1, b: { x: 1, y: 2 } })).toEqual(
      canonicalDigest({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });

  it('digest changes when a value changes', () => {
    expect(canonicalDigest({ a: 1 })).not.toEqual(canonicalDigest({ a: 2 }));
  });

  it('property: key permutations never change the digest', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6 }), fc.integer()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        return canonicalDigest(obj).equals(canonicalDigest(reversed));
      }),
    );
  });

  it('sha256 helpers agree', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('abc').toString('hex')).toBe(sha256Hex('abc'));
  });
});

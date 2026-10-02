import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/** RFC 8785 (JCS) canonical JSON (13.6, 6.5). */
export const canonicalJson = (value: unknown): string => {
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError('value has no canonical JSON form');
  return out;
};

export const sha256 = (data: string | Uint8Array): Buffer =>
  createHash('sha256').update(data).digest();

export const sha256Hex = (data: string | Uint8Array): string => sha256(data).toString('hex');

/** SHA-256 over canonical JSON: key order never changes the digest. */
export const canonicalDigest = (value: unknown): Buffer => sha256(canonicalJson(value));

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealed JSON tokens (22.3): `<prefix><kid>.<base64url(iv | ciphertext | tag)>`.
 * Used for requestState, task IDs, cursors and OAuth `state`. Keys are rotated by adding a new
 * active key and keeping the previous ones in the ring until their tokens expire.
 */

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

export type Keyring = {
  activeKid: string;
  keys: ReadonlyMap<string, Buffer>;
};

type SealOptions = { prefix: string; aad?: string };

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const requireKey = (ring: Keyring, kid: string): Buffer => {
  const key = ring.keys.get(kid);
  if (!key) throw new AeadError('unknown key id');
  if (key.length !== KEY_BYTES) throw new AeadError('keys must be 32 bytes');
  return key;
};

export const sealJson = (value: unknown, ring: Keyring, options: SealOptions): string => {
  const key = requireKey(ring, ring.activeKid);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (options.aad !== undefined) cipher.setAAD(Buffer.from(options.aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return `${options.prefix}${ring.activeKid}.${packed.toString('base64url')}`;
};

export const openJson = (token: string, ring: Keyring, options: SealOptions): unknown => {
  if (!token.startsWith(options.prefix)) throw new AeadError('wrong token prefix');
  const rest = token.slice(options.prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) throw new AeadError('malformed token');
  const encoded = rest.slice(dot + 1);
  const packed = Buffer.from(encoded, 'base64url');
  // Reject non-canonical encodings so that no character of the token can change silently.
  if (packed.toString('base64url') !== encoded || packed.length < IV_BYTES + TAG_BYTES) {
    throw new AeadError('malformed token');
  }
  const key = requireKey(ring, rest.slice(0, dot));
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const body = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    if (options.aad !== undefined) decipher.setAAD(Buffer.from(options.aad));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as unknown;
  } catch {
    throw new AeadError('token failed authentication');
  }
};

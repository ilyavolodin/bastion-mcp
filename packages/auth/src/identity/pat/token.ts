import { createHash, randomBytes } from 'node:crypto';
import { TOKEN_PREFIXES } from '@bastion-mcp/core';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 32 random bytes encode to at most 43 base62 characters; shorter results are left-padded. */
export const PAT_BODY_LENGTH = 43;

export const PAT_PATTERN = new RegExp(`^${TOKEN_PREFIXES.pat}[0-9A-Za-z]{${PAT_BODY_LENGTH}}$`);

export const base62Encode = (bytes: Uint8Array, length: number): string => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, '0');
};

/** `bst_pat_` + 32 random bytes in base62 (9.3). */
export const generatePatToken = (random: (n: number) => Uint8Array = randomBytes): string =>
  `${TOKEN_PREFIXES.pat}${base62Encode(random(32), PAT_BODY_LENGTH)}`;

/** Lowercase hex SHA-256 of the full token, the lookup key stored in `token_sha256` (9.3). */
export const hashPatToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const looksLikePat = (token: string): boolean => token.startsWith(TOKEN_PREFIXES.pat);

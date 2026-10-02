import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time bearer token check (8.3): hashes both sides so lengths never leak. */
export const verifyBearer = (header: string | undefined, token: string | undefined): boolean => {
  if (token === undefined) return false;
  const match = /^Bearer (.+)$/.exec(header ?? '');
  const presented = match?.[1] ?? '';
  const equal = timingSafeEqual(digest(presented), digest(token));
  return equal && match !== null;
};

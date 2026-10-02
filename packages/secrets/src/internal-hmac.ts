import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@bastion-mcp/core';

export const INTERNAL_TS_HEADER = 'X-Bastion-Ts';
export const INTERNAL_SIG_HEADER = 'X-Bastion-Sig';
export const INTERNAL_MAX_SKEW_MS = 30_000;

export type InternalRequestParts = {
  /** Epoch milliseconds, sent as `X-Bastion-Ts`. */
  ts: number;
  method: string;
  path: string;
  body: string | Uint8Array;
};

/** 21.2: `v1=<hex HMAC-SHA256(secret, ts \n method \n path \n sha256(body))>`. */
export const signInternalRequest = (input: InternalRequestParts & { secret: string }): string => {
  const payload = `${input.ts}\n${input.method.toUpperCase()}\n${input.path}\n${sha256Hex(input.body)}`;
  return `v1=${createHmac('sha256', input.secret).update(payload).digest('hex')}`;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'bad_signature' | 'no_secret' };

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/** Accepts the current and previous secret; rejects timestamps more than 30 s from `now`. */
export const verifyInternalRequest = (
  input: InternalRequestParts & {
    signature: string;
    secret: string | undefined;
    previousSecret?: string | undefined;
    now?: number;
  },
): VerifyResult => {
  const secrets = [input.secret, input.previousSecret].filter(
    (s): s is string => s !== undefined && s.length > 0,
  );
  if (secrets.length === 0) return { ok: false, reason: 'no_secret' };
  const now = input.now ?? Date.now();
  if (!Number.isFinite(input.ts) || Math.abs(now - input.ts) > INTERNAL_MAX_SKEW_MS) {
    return { ok: false, reason: 'stale' };
  }
  // Evaluate every candidate so timing does not reveal which secret matched.
  let matched = false;
  for (const secret of secrets) {
    if (safeEqual(signInternalRequest({ ...input, secret }), input.signature)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
};

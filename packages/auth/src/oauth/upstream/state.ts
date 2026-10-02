import { type Keyring, openJson, sealJson } from '@bastion-mcp/core';
import { z } from 'zod';
import { UPSTREAM_STATE_TTL_S } from '../constants';
import type { Clock, PrincipalType, RedisLike } from '../ports';
import { systemClock } from '../ports';

const PREFIX = 'bus1.';

export class UpstreamStateError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid' | 'expired' | 'wrong_principal' | 'replayed',
  ) {
    super(message);
    this.name = 'UpstreamStateError';
  }
}

const statePayload = z.object({
  v: z.literal(1),
  /** principal id (user or service account) */
  u: z.string(),
  t: z.enum(['user', 'service']),
  /** installation id */
  i: z.string(),
  /** nonce, single use */
  n: z.string(),
  /** PKCE verifier (never visible to the browser or the upstream: the token is AEAD-sealed) */
  p: z.string(),
  /** expected issuer (RFC 9207 binding) */
  s: z.string(),
  /** scopes requested */
  c: z.array(z.string()),
  exp: z.number(),
});

export type UpstreamState = {
  principalId: string;
  principalType: PrincipalType;
  installationId: string;
  nonce: string;
  codeVerifier: string;
  issuer: string;
  scopes: string[];
  /** epoch seconds */
  exp: number;
};

/** Signed and encrypted (AES-256-GCM) OAuth state binding user, installation and nonce (9.6, 22.3). */
export const sealUpstreamState = (
  state: Omit<UpstreamState, 'exp'>,
  ring: Keyring,
  clock: Clock = systemClock,
): string =>
  sealJson(
    {
      v: 1,
      u: state.principalId,
      t: state.principalType,
      i: state.installationId,
      n: state.nonce,
      p: state.codeVerifier,
      s: state.issuer,
      c: state.scopes,
      exp: Math.floor(clock.now() / 1000) + UPSTREAM_STATE_TTL_S,
    },
    ring,
    { prefix: PREFIX },
  );

/**
 * Opens and validates a state token: authentic, unexpired, issued to `expectedPrincipalId` (replay across
 * users is refused), and not used before (`incr` on the nonce is atomic).
 */
export const openUpstreamState = async (
  token: string,
  ring: Keyring,
  input: { principalId: string; redis: RedisLike; clock?: Clock },
): Promise<UpstreamState> => {
  const clock = input.clock ?? systemClock;
  let parsed: z.infer<typeof statePayload>;
  try {
    parsed = statePayload.parse(openJson(token, ring, { prefix: PREFIX }));
  } catch {
    throw new UpstreamStateError('invalid state', 'invalid');
  }
  if (parsed.exp * 1000 < clock.now()) throw new UpstreamStateError('state expired', 'expired');
  if (parsed.u !== input.principalId) {
    throw new UpstreamStateError('state was issued to another user', 'wrong_principal');
  }
  const key = `ups:${parsed.n}`;
  const uses = await input.redis.incr(key);
  if (uses === 1) await input.redis.expire(key, UPSTREAM_STATE_TTL_S * 2);
  if (uses > 1) throw new UpstreamStateError('state already used', 'replayed');
  return {
    principalId: parsed.u,
    principalType: parsed.t,
    installationId: parsed.i,
    nonce: parsed.n,
    codeVerifier: parsed.p,
    issuer: parsed.s,
    scopes: parsed.c,
    exp: parsed.exp,
  };
};

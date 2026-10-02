import { createHash } from 'node:crypto';
import type { Infra } from '../../infra';

/**
 * Failure counters of the local (break-glass) login in Redis (9.1, 22.3), shared by every replica. A counter is
 * a fixed window that starts at its first failure; reaching `max` blocks the key until the window ends. Keys
 * for accounts are hashed, so unknown e-mails neither grow the keyspace unboundedly nor behave differently
 * from existing ones.
 */
export type ThrottleRule = { name: string; max: number; windowSeconds: number };

/** Per client address: ten failures in five minutes, whichever accounts were tried. */
export const IP_RULE: ThrottleRule = { name: 'ip', max: 10, windowSeconds: 300 };
/** Per account (existing or not): five failures in fifteen minutes. */
export const ACCOUNT_RULE: ThrottleRule = { name: 'account', max: 5, windowSeconds: 900 };

const keyOf = (rule: ThrottleRule, subject: string): string =>
  `rl:login:${rule.name}:${
    rule.name === 'ip' ? subject : createHash('sha256').update(subject).digest('hex').slice(0, 32)
  }`;

/** Seconds until the key may try again; 0 when it is not blocked. */
export const blockedFor = async (
  infra: Infra,
  rule: ThrottleRule,
  subject: string,
): Promise<number> => {
  const key = keyOf(rule, subject);
  const count = Number(await infra.redis.get(key));
  if (!(count >= rule.max)) return 0;
  const ttl = await infra.redis.ttl(key);
  return ttl > 0 ? ttl : rule.windowSeconds;
};

export const recordFailure = async (
  infra: Infra,
  rule: ThrottleRule,
  subject: string,
): Promise<void> => {
  const key = keyOf(rule, subject);
  const count = await infra.redis.incr(key);
  if (count === 1) await infra.redis.expire(key, rule.windowSeconds);
};

export const clearFailures = async (
  infra: Infra,
  rule: ThrottleRule,
  subject: string,
): Promise<void> => {
  await infra.redis.del(keyOf(rule, subject));
};

/** The longest wait over the rules that block the attempt (0 = go ahead). */
export const loginBlockedFor = async (infra: Infra, ip: string, email: string): Promise<number> =>
  Math.max(await blockedFor(infra, IP_RULE, ip), await blockedFor(infra, ACCOUNT_RULE, email));

export const recordLoginFailure = async (
  infra: Infra,
  ip: string,
  email: string,
): Promise<void> => {
  await recordFailure(infra, IP_RULE, ip);
  await recordFailure(infra, ACCOUNT_RULE, email);
};

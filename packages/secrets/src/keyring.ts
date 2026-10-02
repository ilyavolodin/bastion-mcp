import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Keyring } from '@bastion-mcp/core';
import type { Clock } from './types';
import { systemClock } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export type KeyringPurpose = 'as' | 'upstream-client' | 'state';

export type RotationPolicy = {
  /** A new key becomes active this long after the previous active key's `activeFrom`. */
  rotateEveryMs: number;
  /** The old key keeps verifying/decrypting for this long after the next key takes over. */
  graceMs: number;
};

/** 22.3 / 9.3: as 30 d (+7 d verify), upstream-client 90 d (+7 d), state daily (previous two days accepted). */
export const ROTATION_POLICIES: Record<KeyringPurpose, RotationPolicy> = {
  as: { rotateEveryMs: 30 * DAY_MS, graceMs: 7 * DAY_MS },
  'upstream-client': { rotateEveryMs: 90 * DAY_MS, graceMs: 7 * DAY_MS },
  state: { rotateEveryMs: DAY_MS, graceMs: 2 * DAY_MS },
};

export type KeyTimes = { kid: string; activeFrom: Date; retireAfter: Date };

/** `retire_after` for a key created at `activeFrom` under `policy`. */
export const retireAfterFor = (activeFrom: Date, policy: RotationPolicy): Date =>
  new Date(activeFrom.getTime() + policy.rotateEveryMs + policy.graceMs);

export type RotationPlan = {
  /** True when a new key must be generated now. */
  create: boolean;
  /** Kids past `retireAfter`, to delete (and whose private secrets to remove). */
  retire: string[];
  /** Newest key that is already active and not retired, if any. */
  activeKid: string | undefined;
};

const usable = (keys: readonly KeyTimes[], now: number): KeyTimes[] =>
  keys
    .filter((k) => k.retireAfter.getTime() > now && k.activeFrom.getTime() <= now)
    .sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime());

/** Pure rotation decision (22.3): create when there is no active key or it is older than the interval. */
export const planRotation = (
  keys: readonly KeyTimes[],
  now: Date,
  policy: RotationPolicy,
): RotationPlan => {
  const t = now.getTime();
  const retire = keys.filter((k) => k.retireAfter.getTime() <= t).map((k) => k.kid);
  const newest = usable(keys, t)[0];
  const create = !newest || newest.activeFrom.getTime() + policy.rotateEveryMs <= t;
  return { create, retire, activeKid: newest?.kid };
};

/* ------------------------------- ES256 ------------------------------- */

export type Es256KeyPair = {
  kid: string;
  alg: 'ES256';
  publicJwk: Record<string, string>;
  privateJwk: Record<string, string>;
};

const jwkStrings = (jwk: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(jwk).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );

/** ES256 (P-256) key pair; `kid` is the RFC 7638 JWK thumbprint. */
export const generateEs256KeyPair = (): Es256KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = jwkStrings(publicKey.export({ format: 'jwk' }));
  const priv = jwkStrings(privateKey.export({ format: 'jwk' }));
  const thumbprint = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
  const kid = createHash('sha256').update(thumbprint).digest('base64url');
  return {
    kid,
    alg: 'ES256',
    publicJwk: { ...pub, kid, alg: 'ES256', use: 'sig' },
    privateJwk: { ...priv, kid, alg: 'ES256', use: 'sig' },
  };
};

/* -------------------------------- state -------------------------------- */

export type StateKey = { kid: string; key: Buffer };

/** Key ids contain no `.` (tokens are `<kid>.<payload>`). */
export const generateStateKey = (): StateKey => ({
  kid: `st_${randomBytes(6).toString('base64url')}`,
  key: randomBytes(32),
});

/** Secret name for a state key: scope `system`, name `state:<kid>` (22.3). */
export const stateKeySecretName = (kid: string): string => `state:${kid}`;

export type StateKeyMaterial = KeyTimes & { key: Buffer };

/**
 * Builds the core `Keyring`: every non-retired key can decrypt; the active key is the newest one whose
 * `activeFrom` has passed. Throws when no key is usable (callers rotate first).
 */
export const buildStateKeyring = (keys: readonly StateKeyMaterial[], now: Date): Keyring => {
  const t = now.getTime();
  const live = keys.filter((k) => k.retireAfter.getTime() > t && k.activeFrom.getTime() <= t);
  const [active] = [...live].sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime());
  if (!active) throw new Error('no usable state key; rotate the state keyring');
  return { activeKid: active.kid, keys: new Map(live.map((k) => [k.kid, k.key])) };
};

/* ------------------------------ key store port ------------------------------ */

export type SigningKeyMeta = KeyTimes & {
  purpose: 'as' | 'upstream-client';
  alg: 'ES256';
  publicJwk: Record<string, string>;
};

/**
 * Persistence port for keyrings. The implementation (apps/server or db) stores private ES256 keys and
 * state keys as `system` secrets via `SecretVault` (state keys as `state:<kid>`) and ES256 metadata in
 * `signing_keys` (`private_secret_id`).
 */
export interface KeyStore {
  listSigningKeys(purpose: 'as' | 'upstream-client'): Promise<SigningKeyMeta[]>;
  addSigningKey(meta: SigningKeyMeta, privateJwk: Record<string, string>): Promise<void>;
  loadSigningPrivateKey(kid: string): Promise<Record<string, string>>;
  deleteSigningKeys(kids: string[]): Promise<void>;
  listStateKeys(): Promise<StateKeyMaterial[]>;
  addStateKey(key: StateKeyMaterial): Promise<void>;
  deleteStateKeys(kids: string[]): Promise<void>;
}

export type RotationOutcome = { created: string | undefined; retired: string[] };

/** Applies `planRotation` to a store: generates the new key and deletes expired ones. */
export const rotateKeyring = async (
  store: KeyStore,
  purpose: KeyringPurpose,
  clock: Clock = systemClock,
): Promise<RotationOutcome> => {
  const now = new Date(clock.now());
  const policy = ROTATION_POLICIES[purpose];
  if (purpose === 'state') {
    const plan = planRotation(await store.listStateKeys(), now, policy);
    let created: string | undefined;
    if (plan.create) {
      const fresh = generateStateKey();
      await store.addStateKey({
        ...fresh,
        activeFrom: now,
        retireAfter: retireAfterFor(now, policy),
      });
      created = fresh.kid;
    }
    if (plan.retire.length > 0) await store.deleteStateKeys(plan.retire);
    return { created, retired: plan.retire };
  }
  const plan = planRotation(await store.listSigningKeys(purpose), now, policy);
  let created: string | undefined;
  if (plan.create) {
    const pair = generateEs256KeyPair();
    await store.addSigningKey(
      {
        kid: pair.kid,
        purpose,
        alg: 'ES256',
        publicJwk: pair.publicJwk,
        activeFrom: now,
        retireAfter: retireAfterFor(now, policy),
      },
      pair.privateJwk,
    );
    created = pair.kid;
  }
  if (plan.retire.length > 0) await store.deleteSigningKeys(plan.retire);
  return { created, retired: plan.retire };
};

/** Public JWKS: every non-retired key (old keys verify until `retireAfter`). */
export const buildJwks = (
  keys: readonly SigningKeyMeta[],
  now: Date,
): { keys: Record<string, string>[] } => ({
  keys: keys.filter((k) => k.retireAfter.getTime() > now.getTime()).map((k) => k.publicJwk),
});

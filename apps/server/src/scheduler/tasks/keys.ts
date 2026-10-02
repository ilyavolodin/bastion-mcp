import {
  generateEs256KeyPair,
  generateStateKey,
  type KeyringPurpose,
  ROTATION_POLICIES,
  retireAfterFor,
  rewrapAll,
  rotateKeyring,
} from '@bastion-mcp/secrets';
import { keyStoreOf } from '../../boot/key-store';
import type { Infra } from '../../infra';
import type { TaskContext, TaskFn } from '../types';

export const KEY_PURPOSES: readonly KeyringPurpose[] = ['as', 'upstream-client', 'state'];

export type RotationResult = {
  purpose: KeyringPurpose;
  created: string | undefined;
  retired: string[];
};

/** Tells verifiers, the authorization server and workers to reload their keys (22.3). */
export const publishKeyChange = async (infra: Infra, purposes: readonly KeyringPurpose[]) => {
  for (const purpose of purposes) {
    const topic = purpose === 'state' ? 'state_keys' : 'signing_keys';
    await infra.publish('bastion:config', { topic, scope: 'org', id: purpose });
  }
};

/**
 * 22.3 rotation of one keyring. `force` creates a new active key even when `planRotation` says none is due; the
 * previous key stays valid until its own `retireAfter` (the grace period), then a later run retires it.
 */
export const rotateKeys = async (
  infra: Infra,
  purpose: KeyringPurpose,
  options: { force?: boolean; now?: Date } = {},
): Promise<RotationResult> => {
  const store = keyStoreOf(infra);
  const now = options.now ?? new Date();
  const clock = { now: () => now.getTime() };
  const outcome = await rotateKeyring(store, purpose, clock);
  if (outcome.created !== undefined || !options.force) {
    return { purpose, created: outcome.created, retired: outcome.retired };
  }
  const policy = ROTATION_POLICIES[purpose];
  if (purpose === 'state') {
    const fresh = generateStateKey();
    await store.addStateKey({
      ...fresh,
      activeFrom: now,
      retireAfter: retireAfterFor(now, policy),
    });
    return { purpose, created: fresh.kid, retired: outcome.retired };
  }
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
  return { purpose, created: pair.kid, retired: outcome.retired };
};

/** Daily check (22.3): rotates every keyring that is due, retires expired keys, publishes the change. */
export const keyRotation: TaskFn = async (ctx: TaskContext) => {
  const results: RotationResult[] = [];
  for (const purpose of KEY_PURPOSES) {
    results.push(await rotateKeys(ctx.infra, purpose, { now: ctx.now() }));
  }
  const changed = results.filter((r) => r.created !== undefined || r.retired.length > 0);
  if (changed.length > 0) {
    await publishKeyChange(
      ctx.infra,
      changed.map((r) => r.purpose),
    );
    await ctx.deps.onKeysRotated?.();
  }
  return results;
};

/** Daily: re-wraps data keys still under an older KEK after the KMS key changed (22.3). */
export const kekRewrap: TaskFn = async ({ infra }) => rewrapAll(infra.repos.secrets, infra.kms);

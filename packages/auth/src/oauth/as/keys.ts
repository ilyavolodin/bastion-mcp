import type { SigningKeyMeta } from '@bastion-mcp/secrets';
import type { SigningKeySource } from '../ports';

export type AsJwks = { keys: Record<string, unknown>[] };

/**
 * Private JWKS for oidc-provider (9.3): the newest active key first (oidc-provider signs with the first
 * ES256 key), then older keys that still verify until `retireAfter`.
 */
export const loadAsJwks = async (source: SigningKeySource, nowMs: number): Promise<AsJwks> => {
  const metas = (await source.listSigningKeys('as')).filter(
    (m: SigningKeyMeta) => m.alg === 'ES256' && m.retireAfter.getTime() > nowMs,
  );
  const active = metas
    .filter((m) => m.activeFrom.getTime() <= nowMs)
    .sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime());
  if (active.length === 0) throw new Error('no active AS signing key; rotate the "as" keyring');
  const keys: Record<string, unknown>[] = [];
  for (const meta of active) {
    const jwk = await source.loadSigningPrivateKey(meta.kid);
    keys.push({ ...jwk, kid: meta.kid, alg: 'ES256', use: 'sig' });
  }
  return { keys };
};

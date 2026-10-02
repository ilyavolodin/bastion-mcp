/**
 * `SecretsPort` of the control-plane API over the secret vault: names and metadata only, values go in and never come
 * back (22.3).
 */
import type { SecretMeta, SecretsPort } from '@bastion-mcp/api';
import type { SecretMetadata, SecretVault } from '@bastion-mcp/secrets';

const toMeta = (m: SecretMetadata): SecretMeta => {
  if (m.scope === 'system') throw new Error('system secrets are never exposed');
  return {
    id: m.id,
    scope: m.scope,
    ownerId: m.ownerId,
    name: m.name,
    version: m.version,
    createdAt: m.createdAt.toISOString(),
    updatedAt: (m.updatedAt ?? m.createdAt).toISOString(),
  };
};

export const createSecretsPort = (vault: SecretVault): SecretsPort => ({
  async list(filter) {
    return (await vault.list(filter)).map(toMeta);
  },
  async put(key) {
    return toMeta(await vault.put({ ...key, plaintext: key.value }));
  },
  delete: (key) => vault.delete(key),
});

import type { SecretRef, SecretStore } from '@bastion-mcp/auth';
import type { Repositories } from '@bastion-mcp/db';
import {
  decryptSecret,
  type KmsProvider,
  SecretNotFoundError,
  type SecretVault,
} from '@bastion-mcp/secrets';

/** `SecretStore` of the auth package over the vault; `revealById` goes through the repository (port-matrix 3). */
export const createSecretStore = (
  vault: SecretVault,
  secrets: Repositories['secrets'],
  kms: KmsProvider,
): SecretStore => ({
  async put(ref: SecretRef, value: string) {
    const meta = await vault.put({ ...ref, plaintext: value });
    return { id: meta.id };
  },
  async reveal(ref: SecretRef) {
    try {
      return await vault.revealString(ref);
    } catch (error) {
      if (error instanceof SecretNotFoundError) return null;
      throw error;
    }
  },
  async revealById(id: string) {
    const record = await secrets.getById(id);
    if (!record) return null;
    return (await decryptSecret(kms, record)).toString('utf8');
  },
  async delete(ref: SecretRef) {
    await vault.delete(ref);
  },
});

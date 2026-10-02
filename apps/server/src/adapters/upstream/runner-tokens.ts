import type { RunnerTokenStore } from '@bastion-mcp/mcp-upstream';
import { SecretNotFoundError } from '@bastion-mcp/secrets';
import type { Infra } from '../../infra';

const keyOf = (instanceId: string) => ({
  scope: 'system' as const,
  ownerId: null,
  name: `runner:${instanceId}`,
});

/**
 * `RunnerTokenStore` (port-matrix 16): the runner token is a `system` secret `runner:<instanceId>`, envelope-encrypted
 * through the vault, so a new owner can `driver.attach` after an owner change (21.2, 22.3).
 */
export const createRunnerTokenStore = (infra: Infra): RunnerTokenStore => ({
  async save(instanceId, runnerToken) {
    await infra.vault.put({ ...keyOf(instanceId), plaintext: runnerToken });
  },
  async load(instanceId) {
    try {
      return await infra.vault.revealString(keyOf(instanceId));
    } catch (error) {
      if (error instanceof SecretNotFoundError) return null;
      throw error;
    }
  },
  async delete(instanceId) {
    await infra.vault.delete(keyOf(instanceId));
  },
});

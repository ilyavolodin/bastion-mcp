import { newId } from '@bastion-mcp/core';
import { decryptSecret, encryptSecret } from './envelope';
import { SecretNotFoundError } from './errors';
import type {
  KmsProvider,
  SecretKey,
  SecretMetadata,
  SecretRepository,
  SecretScope,
} from './types';

/**
 * Composes a KMS and a repository. The only method returning a value is `reveal` (for internal
 * callers such as the credential broker); `list` and `put` return metadata only (14, 22.3).
 */
export class SecretVault {
  constructor(
    private readonly kms: KmsProvider,
    private readonly repo: SecretRepository,
  ) {}

  /** Creates the secret or replaces its value, bumping `version`. */
  async put(
    key: SecretKey & { plaintext: Buffer | string },
    signal?: AbortSignal,
  ): Promise<SecretMetadata> {
    const existing = await this.repo.get(key);
    const version = existing ? existing.version + 1 : 1;
    const sealed = await encryptSecret(
      this.kms,
      { scope: key.scope, ownerId: key.ownerId, name: key.name, version, plaintext: key.plaintext },
      signal,
    );
    return this.repo.put({
      id: existing?.id ?? newId(),
      scope: key.scope,
      ownerId: key.ownerId,
      name: key.name,
      version,
      ...sealed,
    });
  }

  /** Internal use only: returns the decrypted value. */
  async reveal(key: SecretKey, signal?: AbortSignal): Promise<Buffer> {
    const record = await this.repo.get(key);
    if (!record) throw new SecretNotFoundError();
    return decryptSecret(this.kms, record, signal);
  }

  async revealString(key: SecretKey, signal?: AbortSignal): Promise<string> {
    return (await this.reveal(key, signal)).toString('utf8');
  }

  async has(key: SecretKey): Promise<boolean> {
    return (await this.repo.get(key)) !== null;
  }

  delete(key: SecretKey): Promise<boolean> {
    return this.repo.delete(key);
  }

  /** Names and metadata only. Strips anything extra a repository might return. */
  async list(filter: { scope: SecretScope; ownerId: string | null }): Promise<SecretMetadata[]> {
    const rows = await this.repo.listMetadata(filter);
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      ownerId: r.ownerId,
      name: r.name,
      version: r.version,
      kekRef: r.kekRef,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}

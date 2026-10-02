import { randomBytes } from 'node:crypto';
import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  createRepositories,
  createSecretRepository,
  type SecretCodec,
  type SecretKey,
  type SecretMetadata,
  withTransaction,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

describe.skipIf(!dbEnabled())('5.3 repository wiring', () => {
  const h = useTestDb();

  it('exposes every aggregate and enables the optional adapters only when their collaborators are supplied', async () => {
    const plain = createRepositories(h.db.prisma);
    expect(Object.keys(plain)).not.toContain('scim');
    expect(Object.keys(plain)).not.toContain('keyStore');
    expect(Object.keys(plain)).not.toContain('marketplaceStore');
    expect(Object.keys(plain)).not.toContain('installationRegistry');
    for (const name of [
      'users',
      'teams',
      'installations',
      'callLog',
      'auditLog',
      'snapshots',
      'router',
      'policyData',
    ]) {
      expect(Object.keys(plain)).toContain(name);
    }

    const secrets = createSecretRepository(h.db.prisma);
    const vault: SecretCodec = {
      put: async (key) =>
        secrets.put({
          id: newId(),
          scope: key.scope,
          ownerId: key.ownerId,
          name: key.name,
          version: 1,
          ciphertext: Buffer.from(key.plaintext),
          iv: randomBytes(12),
          authTag: randomBytes(16),
          wrappedDek: randomBytes(48),
          kekRef: 'k',
        }),
      reveal: async (key: SecretKey) => {
        const rec = await secrets.get(key);
        if (!rec) throw new Error('missing');
        return rec.ciphertext;
      },
      delete: (key) => secrets.delete(key),
      list: (f) => secrets.listMetadata(f) as Promise<SecretMetadata[]>,
    };
    const full = createRepositories(h.db.prisma, {
      scimConflictError: (m) => new Error(m),
      secretVault: vault,
      marketplaceAssemble: () => ({ name: 'n', version: '1', policy: 'available' }),
      configHash: () => 'h',
    });
    for (const name of ['scim', 'keyStore', 'marketplaceStore', 'installationRegistry']) {
      expect(Object.keys(full)).toContain(name);
    }
    await withTransaction(
      h.db.prisma,
      async ({ repos, tx }) => {
        expect(await repos.keyStore?.listStateKeys()).toEqual([]);
        expect(await tx.user.count()).toBe(0);
      },
      { deps: { secretVault: vault } },
    );
  });
});

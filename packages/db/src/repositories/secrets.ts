import { newId, SECRET_SCOPES, SIGNING_KEY_PURPOSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { Secret } from '../generated/client';
import {
  type AuditContext,
  ConflictError,
  isUniqueViolation,
  mutate,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toBytes,
  toContext,
  toJson,
} from './support';

export type SecretScope = (typeof SECRET_SCOPES)[number];

/** Shapes of `@bastion-mcp/secrets` `types.ts` (db may not import it). */
export type SecretKey = { scope: SecretScope; ownerId: string | null; name: string };
export type SecretMetadata = SecretKey & {
  id: string;
  version: number;
  kekRef: string;
  createdAt: Date;
  updatedAt: Date | null;
};
export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kekRef: string;
};
export type SecretRecord = SecretMetadata & EncryptedPayload;
export type SecretWrite = SecretKey & EncryptedPayload & { id: string; version: number };
export type WrappedDekRow = { id: string; wrappedDek: Buffer; kekRef: string };

const scopeSchema = z.enum(SECRET_SCOPES);

const toMeta = (row: Secret): SecretMetadata => ({
  id: row.id,
  scope: scopeSchema.parse(row.scope),
  ownerId: row.ownerId,
  name: row.name,
  version: row.version,
  kekRef: row.kekRef,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRecord = (row: Secret): SecretRecord => ({
  ...toMeta(row),
  ciphertext: Buffer.from(row.ciphertext),
  iv: Buffer.from(row.iv),
  authTag: Buffer.from(row.authTag),
  wrappedDek: Buffer.from(row.wrappedDek),
});

/**
 * `SecretRepository` of `@bastion-mcp/secrets` over the envelope columns of `secrets` (22.3), plus
 * `getById`/`deleteById` for the OAuth `SecretStore` (`client_secret_id`, `secret_id` references).
 * Audit events carry the secret's scope and name, never a value.
 */
export const createSecretRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions & { audit?: AuditContext },
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const audit = options?.audit;
  const where = (key: SecretKey) => ({ scope: key.scope, ownerId: key.ownerId, name: key.name });

  return {
    async get(key: SecretKey): Promise<SecretRecord | null> {
      const row = await db.secret.findFirst({ where: where(key) });
      return row ? toRecord(row) : null;
    },

    async getById(id: string): Promise<SecretRecord | null> {
      const row = await db.secret.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    /** Insert or replace the row for the key (the vault bumps `version` itself). */
    async put(write: SecretWrite): Promise<SecretMetadata> {
      const data = {
        ciphertext: toBytes(write.ciphertext),
        iv: toBytes(write.iv),
        authTag: toBytes(write.authTag),
        wrappedDek: toBytes(write.wrappedDek),
        kekRef: write.kekRef,
        version: write.version,
      };
      const attempt = (): Promise<Secret> =>
        mutate(ctx, async (tx, unit) => {
          const existing = await tx.secret.findFirst({ where: where(write) });
          const row = existing
            ? await tx.secret.update({ where: { id: existing.id }, data })
            : await tx.secret.create({
                data: { id: write.id, ...where(write), ...data },
              });
          unit.audit(audit, {
            action: existing ? 'secret.update' : 'secret.create',
            targetType: 'secret',
            targetId: row.id,
            diff: {
              before: null,
              after: { scope: write.scope, name: write.name, version: row.version },
            },
          });
          return row;
        });
      try {
        return toMeta(await attempt());
      } catch (error) {
        // Two writers created the same key at once: the loser now updates the winner's row.
        if (!isUniqueViolation(error)) throw error;
        return toMeta(await attempt());
      }
    },

    async delete(key: SecretKey): Promise<boolean> {
      return mutate(ctx, async (tx, unit) => {
        const existing = await tx.secret.findFirst({ where: where(key) });
        if (!existing) return false;
        await tx.secret.delete({ where: { id: existing.id } });
        unit.audit(audit, {
          action: 'secret.delete',
          targetType: 'secret',
          targetId: existing.id,
          diff: { before: { scope: key.scope, name: key.name }, after: null },
        });
        return true;
      });
    },

    async deleteById(id: string): Promise<boolean> {
      const res = await db.secret.deleteMany({ where: { id } });
      return res.count > 0;
    },

    /** Never selects ciphertext, IVs or wrapped DEKs. */
    async listMetadata(filter: {
      scope: SecretScope;
      ownerId: string | null;
    }): Promise<SecretMetadata[]> {
      const rows = await db.secret.findMany({
        where: { scope: filter.scope, ownerId: filter.ownerId },
        select: {
          id: true,
          scope: true,
          ownerId: true,
          name: true,
          version: true,
          kekRef: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { name: 'asc' },
      });
      return rows.map((r) => ({ ...r, scope: scopeSchema.parse(r.scope) }));
    },

    async listWrappedDeksNotUnder(
      currentKekRef: string,
      limit: number,
      afterId?: string,
    ): Promise<WrappedDekRow[]> {
      const rows = await db.secret.findMany({
        where: { kekRef: { not: currentKekRef }, ...(afterId ? { id: { gt: afterId } } : {}) },
        select: { id: true, wrappedDek: true, kekRef: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        wrappedDek: Buffer.from(r.wrappedDek),
        kekRef: r.kekRef,
      }));
    },

    /** Replaces only `wrapped_dek` and `kek_ref`; ciphertext, iv, tag and version stay. */
    async updateWrappedDek(id: string, wrappedDek: Buffer, kekRef: string): Promise<void> {
      await db.secret.update({ where: { id }, data: { wrappedDek: toBytes(wrappedDek), kekRef } });
    },
  };
};

// --- KeyStore (signing keys and state keys) -----------------------------------------------------------------------

/** The part of `SecretVault` the key store needs; a `SecretVault` is assignable to it. */
export type SecretCodec = {
  put(key: SecretKey & { plaintext: Buffer | string }): Promise<SecretMetadata>;
  reveal(key: SecretKey): Promise<Buffer>;
  delete(key: SecretKey): Promise<boolean>;
  list(filter: { scope: SecretScope; ownerId: string | null }): Promise<SecretMetadata[]>;
};

export type KeyTimes = { kid: string; activeFrom: Date; retireAfter: Date };
export type SigningKeyMeta = KeyTimes & {
  purpose: (typeof SIGNING_KEY_PURPOSES)[number];
  alg: 'ES256';
  publicJwk: Record<string, string>;
};
export type StateKeyMaterial = KeyTimes & { key: Buffer };

const purposeSchema = z.enum(SIGNING_KEY_PURPOSES);
const jwkSchema = z.record(z.string(), z.string());
const stateSecretSchema = z.object({
  key: z.string(),
  activeFrom: z.string(),
  retireAfter: z.string(),
});

const signingSecretKey = (kid: string): SecretKey => ({
  scope: 'system',
  ownerId: null,
  name: `signing:${kid}`,
});
const stateSecretKey = (kid: string): SecretKey => ({
  scope: 'system',
  ownerId: null,
  name: `state:${kid}`,
});

/**
 * `KeyStore` of `@bastion-mcp/secrets` and the `SigningKeySource` ports (22.3, 9.3): private ES256 keys
 * and state keys are `system` secrets (`signing:<kid>`, `state:<kid>`); ES256 metadata lives in
 * `signing_keys` with `private_secret_id`. State-key validity windows travel inside the encrypted value.
 */
export const createKeyStore = (
  arg: PrismaLike | RepoContext,
  vault: SecretCodec,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const listSigningKeys = async (purpose: SigningKeyMeta['purpose']): Promise<SigningKeyMeta[]> => {
    const rows = await db.signingKey.findMany({
      where: { purpose },
      orderBy: [{ activeFrom: 'asc' }, { kid: 'asc' }],
    });
    return rows.map((r) => ({
      kid: r.kid,
      purpose: purposeSchema.parse(r.purpose),
      alg: z.literal('ES256').parse(r.alg),
      publicJwk: jwkSchema.parse(r.publicJwk),
      activeFrom: r.activeFrom,
      retireAfter: r.retireAfter,
    }));
  };

  return {
    listSigningKeys,

    async addSigningKey(meta: SigningKeyMeta, privateJwk: Record<string, string>): Promise<void> {
      // Checked before touching the vault: a duplicate must not overwrite the live private key.
      if (await db.signingKey.findUnique({ where: { kid: meta.kid }, select: { id: true } })) {
        throw new ConflictError('signing key already exists', { kid: meta.kid });
      }
      const secret = await vault.put({
        ...signingSecretKey(meta.kid),
        plaintext: JSON.stringify(privateJwk),
      });
      try {
        await mutate(ctx, async (tx, unit) => {
          await tx.signingKey.create({
            data: {
              id: newId(),
              purpose: meta.purpose,
              kid: meta.kid,
              alg: meta.alg,
              publicJwk: toJson(meta.publicJwk),
              privateSecretId: secret.id,
              activeFrom: meta.activeFrom,
              retireAfter: meta.retireAfter,
            },
          });
          unit.audit(
            { actorType: 'system' },
            {
              action: 'signing_key.create',
              targetType: 'signing_key',
              targetId: meta.kid,
              diff: { before: null, after: { purpose: meta.purpose, kid: meta.kid } },
            },
          );
        });
      } catch (error) {
        await vault.delete(signingSecretKey(meta.kid));
        throw error;
      }
    },

    async loadSigningPrivateKey(kid: string): Promise<Record<string, string>> {
      const value = await vault.reveal(signingSecretKey(kid));
      return jwkSchema.parse(JSON.parse(value.toString('utf8')));
    },

    async deleteSigningKeys(kids: string[]): Promise<void> {
      if (kids.length === 0) return;
      await mutate(ctx, async (tx, unit) => {
        await tx.signingKey.deleteMany({ where: { kid: { in: kids } } });
        unit.audit(
          { actorType: 'system' },
          {
            action: 'signing_key.retire',
            targetType: 'signing_key',
            targetId: kids.join(','),
            diff: { before: { kids }, after: null },
          },
        );
      });
      for (const kid of kids) await vault.delete(signingSecretKey(kid));
    },

    async listStateKeys(): Promise<StateKeyMaterial[]> {
      const metas = await vault.list({ scope: 'system', ownerId: null });
      const out: StateKeyMaterial[] = [];
      for (const meta of metas) {
        if (!meta.name.startsWith('state:')) continue;
        const kid = meta.name.slice('state:'.length);
        const parsed = stateSecretSchema.parse(
          JSON.parse((await vault.reveal(stateSecretKey(kid))).toString('utf8')),
        );
        out.push({
          kid,
          key: Buffer.from(parsed.key, 'base64'),
          activeFrom: new Date(parsed.activeFrom),
          retireAfter: new Date(parsed.retireAfter),
        });
      }
      return out.sort((a, b) => a.activeFrom.getTime() - b.activeFrom.getTime());
    },

    async addStateKey(key: StateKeyMaterial): Promise<void> {
      await vault.put({
        ...stateSecretKey(key.kid),
        plaintext: JSON.stringify({
          key: key.key.toString('base64'),
          activeFrom: key.activeFrom.toISOString(),
          retireAfter: key.retireAfter.toISOString(),
        }),
      });
    },

    async deleteStateKeys(kids: string[]): Promise<void> {
      for (const kid of kids) await vault.delete(stateSecretKey(kid));
    },
  };
};

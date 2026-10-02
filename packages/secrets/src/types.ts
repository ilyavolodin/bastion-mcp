import type { SECRET_SCOPES } from '@bastion-mcp/core';

export type SecretScope = (typeof SECRET_SCOPES)[number];

/** Injectable time source so caches and rotation are testable with a fake clock. */
export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

/** Identity of a secret row: unique on (scope, ownerId, name) (16.2). `ownerId` is null for org/system. */
export type SecretKey = {
  scope: SecretScope;
  ownerId: string | null;
  name: string;
};

/** Everything about a secret except the value; safe to list and log. */
export type SecretMetadata = SecretKey & {
  id: string;
  version: number;
  kekRef: string;
  createdAt: Date;
  updatedAt: Date | null;
};

/** The encrypted columns of a `secrets` row. */
export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  kekRef: string;
};

export type SecretRecord = SecretMetadata & EncryptedPayload;

/** Row to insert or replace; the repository sets timestamps. */
export type SecretWrite = SecretKey & EncryptedPayload & { id: string; version: number };

/** A row's wrapped DEK, used by KEK rotation. Never carries ciphertext. */
export type WrappedDekRow = { id: string; wrappedDek: Buffer; kekRef: string };

/**
 * Storage port for secrets (implemented by `@bastion-mcp/db`). `listMetadata` MUST NOT return
 * ciphertext, IVs or wrapped DEKs.
 */
export interface SecretRepository {
  get(key: SecretKey): Promise<SecretRecord | null>;
  /** Insert or replace the row for the key. */
  put(write: SecretWrite): Promise<SecretMetadata>;
  delete(key: SecretKey): Promise<boolean>;
  listMetadata(filter: { scope: SecretScope; ownerId: string | null }): Promise<SecretMetadata[]>;
  /** Rows whose `kek_ref` differs from `currentKekRef`, ordered by id, strictly after `afterId`. */
  listWrappedDeksNotUnder(
    currentKekRef: string,
    limit: number,
    afterId?: string,
  ): Promise<WrappedDekRow[]>;
  /** Replaces only `wrapped_dek` and `kek_ref`; ciphertext, iv, tag and version stay. */
  updateWrappedDek(id: string, wrappedDek: Buffer, kekRef: string): Promise<void>;
}

/** Key encryption key provider (22.3). */
export interface KmsProvider {
  /** Identifies the KEK currently used by `wrap`; stored as `secrets.kek_ref`. */
  readonly kekRef: string;
  wrap(dek: Buffer, signal?: AbortSignal): Promise<Buffer>;
  /** `kekRef` is the reference stored with the row, which may be an older KEK. */
  unwrap(wrapped: Buffer, kekRef: string, signal?: AbortSignal): Promise<Buffer>;
  health(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KmsUnavailableError, SecretIntegrityError } from './errors';
import type { EncryptedPayload, KmsProvider, SecretKey } from './types';

const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptInput = SecretKey & { version: number; plaintext: Buffer | string };
export type DecryptInput = SecretKey & EncryptedPayload & { version: number };
type Unwrapper = Pick<KmsProvider, 'unwrap'>;

/** AAD = `scope|owner_id|name|version` (22.3); a null owner is the empty string. */
export const buildAad = (key: SecretKey & { version: number }): Buffer =>
  Buffer.from(`${key.scope}|${key.ownerId ?? ''}|${key.name}|${key.version}`, 'utf8');

/** 22.3: a fresh DEK per call; the value is sealed with AES-256-GCM and the DEK wrapped by the KMS. */
export const encryptSecret = async (
  kms: Pick<KmsProvider, 'wrap' | 'kekRef'>,
  input: EncryptInput,
  signal?: AbortSignal,
): Promise<EncryptedPayload> => {
  const dek = randomBytes(DEK_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(buildAad(input));
    const plain =
      typeof input.plaintext === 'string' ? Buffer.from(input.plaintext) : input.plaintext;
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrappedDek = await kms.wrap(dek, signal);
    return { ciphertext, iv, authTag, wrappedDek, kekRef: kms.kekRef };
  } finally {
    dek.fill(0);
  }
};

/** Opens a record. The KMS is only asked for the DEK; any authentication failure is a SecretIntegrityError. */
export const decryptSecret = async (
  kms: Unwrapper,
  record: DecryptInput,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const dek = await kms.unwrap(record.wrappedDek, record.kekRef, signal);
  return openWithDek(dek, record);
};

export const openWithDek = (dek: Buffer, record: DecryptInput): Buffer => {
  if (dek.length !== DEK_BYTES) throw new KmsUnavailableError('KMS returned a malformed data key');
  if (record.iv.length !== IV_BYTES || record.authTag.length !== TAG_BYTES) {
    throw new SecretIntegrityError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, record.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(record));
    decipher.setAuthTag(record.authTag);
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
  } catch {
    throw new SecretIntegrityError();
  }
};

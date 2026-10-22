/**
 * The backup file: one AES-256-GCM envelope around the gzipped backup document, keyed from the operator's passphrase
 * with scrypt. The whole document is sealed (not only the secrets) because it also carries user data, token hashes and
 * OAuth grants. The cleartext header is authenticated as additional data, so it cannot be altered without detection.
 *
 *   "BSTNBK01" | u32be header length | header JSON | ciphertext | 16-byte tag
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('BSTNBK01', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Memory-hard cost (about 128 MiB per derivation): an offline guess costs the same as an online one. */
const KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
const KDF_MAXMEM = 256 * 1024 * 1024;
export const MIN_PASSPHRASE_LENGTH = 12;
/** Refuses to inflate more than this (a corrupted or hostile file). */
const MAX_PLAIN_BYTES = 2 * 1024 * 1024 * 1024;

export class BackupFileError extends Error {}

export type BackupHeader = {
  format: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  createdAt: string;
  /** Last migration applied when the backup was taken. */
  migration: string | null;
};

const deriveKey = (passphrase: string, header: Pick<BackupHeader, 'n' | 'r' | 'p' | 'salt'>) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      Buffer.from(header.salt, 'base64'),
      KEY_BYTES,
      { N: header.n, r: header.r, p: header.p, maxmem: KDF_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

const framing = (header: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header]);
};

export const sealBackup = async (
  document: unknown,
  passphrase: string,
  meta: { createdAt: Date; migration: string | null },
): Promise<Buffer> => {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupFileError(`the passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const header: BackupHeader = {
    format: 1,
    kdf: 'scrypt',
    n: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: randomBytes(SALT_BYTES).toString('base64'),
    iv: randomBytes(IV_BYTES).toString('base64'),
    createdAt: meta.createdAt.toISOString(),
    migration: meta.migration,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const key = await deriveKey(passphrase, header);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'), {
      authTagLength: TAG_BYTES,
    });
    const aad = framing(headerBytes);
    cipher.setAAD(aad);
    const plain = gzipSync(Buffer.from(JSON.stringify(document), 'utf8'));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([aad, body, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
};

/** Reads the cleartext header without the passphrase (the console shows it before asking to decrypt). */
export const readBackupHeader = (file: Buffer): { header: BackupHeader; aad: Buffer } => {
  if (file.length < MAGIC.length + 4 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFileError('not a Bastion backup file');
  }
  const headerLength = file.readUInt32BE(MAGIC.length);
  const end = MAGIC.length + 4 + headerLength;
  if (headerLength > 64 * 1024 || file.length < end + TAG_BYTES) {
    throw new BackupFileError('the backup file is truncated or damaged');
  }
  let header: BackupHeader;
  try {
    header = JSON.parse(file.subarray(MAGIC.length + 4, end).toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupFileError('the backup file header is damaged');
  }
  if (header.format !== 1 || header.kdf !== 'scrypt') {
    throw new BackupFileError('this backup was made by a newer version of Bastion');
  }
  if (!(header.n <= 2 ** 20 && header.r <= 16 && header.p <= 4)) {
    throw new BackupFileError('the backup file header is damaged');
  }
  return { header, aad: file.subarray(0, end) };
};

export const openBackup = async (
  file: Buffer,
  passphrase: string,
): Promise<{
  document: unknown;
  header: BackupHeader;
}> => {
  const { header, aad } = readBackupHeader(file);
  const key = await deriveKey(passphrase, header);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(file.subarray(file.length - TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(file.subarray(aad.length, file.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new BackupFileError('wrong passphrase, or the backup file is damaged');
    }
    const json = gunzipSync(plain, { maxOutputLength: MAX_PLAIN_BYTES });
    return { document: JSON.parse(json.toString('utf8')), header };
  } finally {
    key.fill(0);
  }
};

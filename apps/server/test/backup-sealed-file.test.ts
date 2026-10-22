import { describe, expect, it } from 'vitest';
import {
  BackupFileError,
  openBackup,
  readBackupHeader,
  sealBackup,
} from '../src/backup/sealed-file';

const PASS = 'correct horse battery staple';
const meta = { createdAt: new Date('2026-10-22T00:00:00Z'), migration: '0004_idp_redirect_root' };

describe('backup file envelope', () => {
  it('seals and opens a document with the passphrase', async () => {
    const file = await sealBackup({ hello: 'world', n: [1, 2, 3] }, PASS, meta);
    const { document, header } = await openBackup(file, PASS);
    expect(document).toEqual({ hello: 'world', n: [1, 2, 3] });
    expect(header.migration).toBe('0004_idp_redirect_root');
    expect(header.createdAt).toBe('2026-10-22T00:00:00.000Z');
  });

  it('shows no document content without the passphrase', async () => {
    const file = await sealBackup({ secret: 'hunter2-hunter2' }, PASS, meta);
    expect(file.includes(Buffer.from('hunter2'))).toBe(false);
    expect(readBackupHeader(file).header.format).toBe(1);
  });

  it('rejects a wrong passphrase', async () => {
    const file = await sealBackup({ a: 1 }, PASS, meta);
    await expect(openBackup(file, 'another passphrase!')).rejects.toThrow(/wrong passphrase/);
  });

  it('rejects a changed header (authenticated as additional data)', async () => {
    const file = Buffer.from(await sealBackup({ a: 1 }, PASS, meta));
    const at = file.indexOf('0004_idp');
    file[at + 1] = file[at + 1] === 0x31 ? 0x32 : 0x31;
    await expect(openBackup(file, PASS)).rejects.toThrow(BackupFileError);
  });

  it('rejects a changed body and a truncated file', async () => {
    const file = Buffer.from(await sealBackup({ a: 1 }, PASS, meta));
    const tampered = Buffer.from(file);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 0xff;
    await expect(openBackup(tampered, PASS)).rejects.toThrow(/wrong passphrase|damaged/);
    await expect(openBackup(file.subarray(0, 30), PASS)).rejects.toThrow(BackupFileError);
  });

  it('rejects files that are not backups, and short passphrases', async () => {
    await expect(openBackup(Buffer.from('definitely not a backup file'), PASS)).rejects.toThrow(
      /not a Bastion backup/,
    );
    await expect(sealBackup({}, 'short', meta)).rejects.toThrow(/at least 12/);
  });

  it('uses a fresh salt and IV for every file', async () => {
    const a = readBackupHeader(await sealBackup({}, PASS, meta)).header;
    const b = readBackupHeader(await sealBackup({}, PASS, meta)).header;
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});

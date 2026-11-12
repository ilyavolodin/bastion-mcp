import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execute, HELP } from '../src/cli/commands';

const run = async (argv: string[], env: Record<string, string | undefined> = {}, stdin = '') => {
  const out: string[] = [];
  const err: string[] = [];
  let stdinReads = 0;
  const code = await execute(argv, env, {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    stdin: async () => {
      stdinReads += 1;
      return stdin;
    },
  });
  return { code, out, err, stdinReads };
};

const tmp = mkdtempSync(join(tmpdir(), 'bastion-cli-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('20.1 CLI commands that fail before touching infrastructure', () => {
  it('20.1 help flag and help command print HELP and exit 0', async () => {
    for (const argv of [['help'], ['migrate', '--help'], ['-h']]) {
      const r = await run(argv);
      expect(r).toMatchObject({ code: 0, out: [HELP], err: [] });
    }
  });

  it('20.1 an unknown command exits 2 with the command and HELP', async () => {
    const r = await run(['frobnicate']);
    expect(r).toMatchObject({ code: 2, out: [], err: [`unknown command "frobnicate"\n\n${HELP}`] });
  });

  it('20.1 create-admin and reset-password need --email and do not read stdin without it', async () => {
    expect(await run(['create-admin', '--password-stdin'], {}, 'pw')).toEqual({
      code: 2,
      out: [],
      err: ['create-admin requires --email <address>'],
      stdinReads: 0,
    });
    expect(await run(['reset-password'])).toEqual({
      code: 2,
      out: [],
      err: ['reset-password requires --email <address>'],
      stdinReads: 0,
    });
    // a bare --email (no value) is a boolean flag, so no address
    expect((await run(['create-admin', '--email'])).code).toBe(2);
  });

  it('20.1 create-admin reads stdin before the configuration is loaded', async () => {
    const r = await run(['create-admin', '--email', 'a@b.c', '--password-stdin'], {}, ' secret \n');
    expect(r.stdinReads).toBe(1);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.err.every((l) => l.startsWith('config error: '))).toBe(true);
  });

  it('20.1 reset-password without --password-stdin does not read stdin', async () => {
    const r = await run(['reset-password', '--email', 'a@b.c']);
    expect(r.stdinReads).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err.every((l) => l.startsWith('config error: '))).toBe(true);
  });

  it('20.1 set-role needs both --email and --role', async () => {
    const message = 'set-role requires --email <address> and --role admin | auditor | member';
    expect(await run(['set-role', '--email', 'a@b.c'])).toMatchObject({ code: 2, err: [message] });
    expect(await run(['set-role', '--role', 'admin'])).toMatchObject({ code: 2, err: [message] });
  });

  it('20.1 rotate-keys needs a known --purpose', async () => {
    const bad = await run(['rotate-keys', '--purpose', 'nope']);
    expect(bad.code).toBe(2);
    expect(bad.err).toEqual(['rotate-keys requires --purpose as | upstream-client | state']);
    expect((await run(['rotate-keys'])).code).toBe(2);
  });

  it('20.1 import-config rejects invalid JSON from stdin or a file with exit 2', async () => {
    const r = await run(['import-config'], {}, '{nope');
    expect(r).toEqual({
      code: 2,
      out: [],
      err: ['import-config: input is not valid JSON'],
      stdinReads: 1,
    });
    const file = join(tmp, 'bad.json');
    writeFileSync(file, 'not json');
    const f = await run(['import-config', '--file', file], {}, '{}');
    expect(f).toMatchObject({
      code: 2,
      err: ['import-config: input is not valid JSON'],
      stdinReads: 0,
    });
  });

  it('20.1 import-config with a missing file throws into the shared handler (exit 1, message)', async () => {
    const r = await run(['import-config', '--file', join(tmp, 'absent.json')]);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain('ENOENT');
  });

  it('20.1 backup needs --out and then a passphrase', async () => {
    expect(await run(['backup'])).toMatchObject({
      code: 2,
      err: ['backup: --out <file> is required'],
    });
    const noPass = await run(['backup', '--out', join(tmp, 'b.bak')]);
    expect(noPass.code).toBe(2);
    expect(noPass.err).toEqual([
      'a passphrase is required: set BASTION_BACKUP_PASSPHRASE or use --passphrase-stdin',
    ]);
    const emptyStdin = await run(['backup', '--out', 'x', '--passphrase-stdin'], {}, '\nsecond');
    expect(emptyStdin).toMatchObject({ code: 2, stdinReads: 1 });
    expect(emptyStdin.err).toHaveLength(1);
  });

  it('20.1 restore validates --file, --mode and the passphrase in that order', async () => {
    expect(await run(['restore'])).toMatchObject({
      code: 2,
      err: ['restore: --file <backup> is required'],
    });
    expect(
      await run(['restore', '--file', 'f', '--mode', 'wipe'], { BASTION_BACKUP_PASSPHRASE: 'p' }),
    ).toMatchObject({ code: 2, err: ['restore: --mode must be merge or replace'], stdinReads: 0 });
    const noPass = await run(['restore', '--file', 'f', '--mode', 'replace']);
    expect(noPass.code).toBe(2);
    expect(noPass.err).toEqual([
      'a passphrase is required: set BASTION_BACKUP_PASSPHRASE or use --passphrase-stdin',
    ]);
  });

  it('20.1 maintenance expects on, off or status', async () => {
    const r = await run(['maintenance', 'toggle']);
    expect(r).toMatchObject({ code: 2, err: ['maintenance: expected on, off or status'] });
    expect((await run(['maintenance'])).code).toBe(2);
  });

  it('20.1 commands that need the configuration report config errors line by line (exit 1)', async () => {
    for (const argv of [['migrate'], ['export-config'], ['maintenance', 'status']]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err.length).toBeGreaterThan(0);
      expect(r.err.every((l) => l.startsWith('config error: '))).toBe(true);
    }
  });

  it('20.1 check-config prints a FAIL table and exits 1 on a broken configuration', async () => {
    const r = await run(['check-config']);
    expect(r.code).toBe(1);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toContain('FAIL');
  });
});

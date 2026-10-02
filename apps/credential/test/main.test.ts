import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KeyringTokenStore } from '../src/keyring-store';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

const run = (args: string[], env: Record<string, string>) => {
  const home = mkdtempSync(join(tmpdir(), 'bastion-cred-home-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', main, ...args], {
      cwd,
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

describe('25.6 bastion-credential binary (entry point)', () => {
  it('25.6 explains the configuration when neither BASTION_URL nor the config file exists', () => {
    const result = run(['token'], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BASTION_URL');
    expect(result.stdout).toBe('');
  });

  it('25.6 prints usage for unknown commands', () => {
    const result = run(['bogus'], { BASTION_URL: 'https://mcp.example.com' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });

  it('25.6 git calls for other hosts get an empty answer without touching the keychain', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', main, 'get'], {
      cwd,
      encoding: 'utf8',
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', BASTION_URL: 'https://mcp.example.com' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  // Opt-in: writes to the real OS keychain.
  it.skipIf(process.env.BASTION_TEST_KEYCHAIN !== '1')(
    '25.6 keeps the refresh token in the OS keychain',
    async () => {
      const store = new KeyringTokenStore();
      const key = `https://test-${Date.now()}.example.com`;
      await store.set(key, 'refresh-1');
      expect(await store.get(key)).toBe('refresh-1');
      await store.delete(key);
      expect(await store.get(key)).toBeUndefined();
    },
  );
});

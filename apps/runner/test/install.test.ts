import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type StartRequest, startRequestSchema } from '@bastion-mcp/sandbox/protocol';
import { describe, expect, it } from 'vitest';
import {
  assertLockfileIntegrity,
  buildInstallEnv,
  buildNpmPlan,
  buildUvPlan,
  createInstaller,
  type ExecFn,
  InstallError,
  redactSecrets,
  resolveNpmBinName,
  sha256Hex,
} from '../src/install';
import { buildServerEnv } from '../src/process';

const base = {
  runtime: 'npm' as const,
  identifier: '@scope/server-x',
  version: '1.2.3',
  egress: { proxyUrl: 'http://inst:tok@10.0.0.5:3128' },
};
const parse = (extra: Record<string, unknown> = {}): StartRequest =>
  startRequestSchema.parse({ ...base, ...extra });

const lock = (kind: 'npm-shrinkwrap' | 'uv-requirements', content: string) => ({
  kind,
  content,
  sha256: sha256Hex(content),
});

describe('8.3 install plans', () => {
  it('8.3 npm with lockfile: shrinkwrap + generated package.json + npm ci --ignore-scripts', () => {
    const plan = buildNpmPlan(parse({ lockfile: lock('npm-shrinkwrap', '{"lockfileVersion":3}') }));
    expect(plan.files.map((f) => f.path)).toEqual(['package.json', 'npm-shrinkwrap.json']);
    expect(JSON.parse(plan.files[0]?.content ?? '{}')).toMatchObject({
      dependencies: { '@scope/server-x': '1.2.3' },
    });
    expect(plan.commands).toEqual([
      {
        command: 'npm',
        args: [
          'ci',
          '--prefix',
          '/opt/mcp',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
        ],
      },
    ]);
  });

  it('8.7 install scripts run only when allowInstallScripts is set', () => {
    const plan = buildNpmPlan(
      parse({ allowInstallScripts: true, lockfile: lock('npm-shrinkwrap', '{}') }),
    );
    expect(plan.commands[0]?.args).not.toContain('--ignore-scripts');
  });

  it('8.3 npm without lockfile installs identifier@version', () => {
    const plan = buildNpmPlan(parse());
    expect(plan.commands[0]?.args).toContain('@scope/server-x@1.2.3');
    expect(plan.commands[0]?.args[0]).toBe('install');
    expect(plan.commands[0]?.args).toContain('--ignore-scripts');
  });

  it('8.3 pypi with lockfile: uv venv 3.13 then uv pip install --require-hashes', () => {
    const plan = buildUvPlan(
      parse({
        runtime: 'pypi',
        identifier: 'mcp-server-fetch',
        lockfile: lock('uv-requirements', 'pkg==1 --hash=sha256:aa'),
      }),
    );
    expect(plan.files).toEqual([{ path: 'requirements.txt', content: 'pkg==1 --hash=sha256:aa' }]);
    expect(plan.commands[0]).toEqual({
      command: 'uv',
      args: ['venv', '/opt/mcp/.venv', '--python', '3.13'],
    });
    expect(plan.commands[1]?.args).toEqual([
      'pip',
      'install',
      '--python',
      '/opt/mcp/.venv/bin/python',
      '--require-hashes',
      '-r',
      '/opt/mcp/requirements.txt',
    ]);
  });

  it('8.3 pypi without lockfile installs identifier==version', () => {
    const plan = buildUvPlan(
      parse({ runtime: 'pypi', identifier: 'mcp-server-fetch', version: '2025.1' }),
    );
    expect(plan.commands[1]?.args.at(-1)).toBe('mcp-server-fetch==2025.1');
  });

  it('8.7 a lockfile of the wrong kind is refused', () => {
    expect(() => buildNpmPlan(parse({ lockfile: lock('uv-requirements', 'x') }))).toThrow(
      InstallError,
    );
    expect(() =>
      buildUvPlan(parse({ runtime: 'pypi', lockfile: lock('npm-shrinkwrap', 'x') })),
    ).toThrow(InstallError);
  });

  it('8.7 lockfile integrity: a sha256 mismatch fails before any command runs', () => {
    expect(() =>
      assertLockfileIntegrity({ kind: 'npm-shrinkwrap', content: 'x', sha256: 'a'.repeat(64) }),
    ).toThrow(/integrity/);
    expect(() => assertLockfileIntegrity(lock('npm-shrinkwrap', 'x'))).not.toThrow();
  });
});

describe('8.3 npm bin resolution', () => {
  it('8.3 string bin uses the unscoped package name', () => {
    expect(resolveNpmBinName({ bin: './cli.js' }, '@scope/server-x', undefined)).toBe('server-x');
  });
  it('8.3 single object bin is used; several need `bin` or a name match', () => {
    expect(resolveNpmBinName({ bin: { run: 'a.js' } }, 'pkg', undefined)).toBe('run');
    expect(resolveNpmBinName({ bin: { a: 'a', b: 'b' } }, 'pkg', 'b')).toBe('b');
    expect(resolveNpmBinName({ bin: { pkg: 'a', b: 'b' } }, 'pkg', undefined)).toBe('pkg');
    expect(() => resolveNpmBinName({ bin: { a: 'a', b: 'b' } }, 'pkg', undefined)).toThrow(
      /several/,
    );
    expect(() => resolveNpmBinName({ bin: { a: 'a' } }, 'pkg', 'zzz')).toThrow(/no bin/);
    expect(() => resolveNpmBinName({ bin: './x' }, 'pkg', 'other')).toThrow(/no bin/);
    expect(() => resolveNpmBinName({}, 'pkg', undefined)).toThrow(/no bin/);
  });
});

describe('8.3 environments', () => {
  it('8.3 install env carries the proxy and the configured mirrors', () => {
    const env = buildInstallEnv(
      parse({ registry: { npm: 'https://npm.mirror/', pypi: 'https://pypi.mirror/simple' } }),
      { path: '/usr/bin', home: '/home/sandbox' },
    );
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://inst:tok@10.0.0.5:3128',
      HTTP_PROXY: 'http://inst:tok@10.0.0.5:3128',
      NO_PROXY: '',
      npm_config_registry: 'https://npm.mirror/',
      UV_INDEX_URL: 'https://pypi.mirror/simple',
    });
  });

  it('8.3 the server env is clean: only spec env, HOME, PATH and proxy variables', () => {
    const env = buildServerEnv({
      command: 'x',
      args: [],
      env: { API_KEY: 'k', HOME: '/evil', HTTPS_PROXY: 'http://evil' },
      proxyUrl: 'http://p:1',
      cwd: '/workspace',
      home: '/home/sandbox',
      path: '/usr/bin',
    });
    expect(env).toEqual({
      API_KEY: 'k',
      HOME: '/home/sandbox',
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://p:1',
      HTTP_PROXY: 'http://p:1',
      NO_PROXY: '',
    });
  });

  it('8.3 redacts proxy credentials and env secrets from details', () => {
    expect(redactSecrets('GET http://inst:toksecret@h toksecret', ['toksecret', 'x'])).toBe(
      'GET http://inst:[redacted]@h [redacted]',
    );
  });
});

describe('8.3 installer execution', () => {
  it('8.3 writes files, runs the commands and resolves the bin from package.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-install-'));
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      // emulate the install result
      const pkgDir = path.join(root, 'node_modules', '@scope', 'server-x');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ bin: { 'server-x': 'i.js' } }),
      );
      return { code: 0, output: '' };
    };
    const details: string[] = [];
    const installer = createInstaller({ root, exec });
    const resolved = await installer.install(
      parse({ lockfile: lock('npm-shrinkwrap', '{"a":1}'), args: ['--stdio'] }),
      { signal: new AbortController().signal, env: {}, onDetail: (d) => details.push(d) },
    );
    expect(calls[0]?.slice(0, 2)).toEqual(['npm', 'ci']);
    expect(await readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8')).toBe('{"a":1}');
    expect(resolved).toEqual({
      command: path.join(root, 'node_modules', '.bin', 'server-x'),
      args: ['--stdio'],
    });
    expect(details).toEqual(['npm ci']);
  });

  it('8.3 pypi resolves /opt/mcp/.venv/bin/<bin>', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-install-'));
    const installer = createInstaller({ root, exec: async () => ({ code: 0, output: '' }) });
    const resolved = await installer.install(
      parse({ runtime: 'pypi', identifier: 'mcp-server-fetch', bin: 'mcp-fetch' }),
      {
        signal: new AbortController().signal,
        env: {},
        onDetail: () => {},
      },
    );
    expect(resolved.command).toBe(`${root}/.venv/bin/mcp-fetch`);
  });

  it('8.3 a failing command surfaces its output as an InstallError', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-install-'));
    const installer = createInstaller({
      root,
      exec: async () => ({ code: 1, output: 'E404 not found' }),
    });
    await expect(
      installer.install(parse(), {
        signal: new AbortController().signal,
        env: {},
        onDetail: () => {},
      }),
    ).rejects.toThrow(/E404/);
  });

  it('8.7 a tampered lockfile is rejected before executing anything', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-install-'));
    let ran = false;
    const installer = createInstaller({
      root,
      exec: async () => {
        ran = true;
        return { code: 0, output: '' };
      },
    });
    const bad = { kind: 'npm-shrinkwrap', content: '{}', sha256: 'b'.repeat(64) };
    await expect(
      installer.install(parse({ lockfile: bad }), {
        signal: new AbortController().signal,
        env: {},
        onDetail: () => {},
      }),
    ).rejects.toThrow(/integrity/);
    expect(ran).toBe(false);
  });

  it('8.3 a missing installed package.json is reported', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-install-'));
    const installer = createInstaller({ root, exec: async () => ({ code: 0, output: '' }) });
    await expect(
      installer.install(parse(), {
        signal: new AbortController().signal,
        env: {},
        onDetail: () => {},
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('8.7 lockfile capture in the runner', () => {
  const ctx = { signal: new AbortController().signal, env: {}, onDetail: () => {} };

  it('8.7 npm capture runs npm install --package-lock-only and returns package-lock.json as a shrinkwrap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-capture-'));
    const calls: string[][] = [];
    const installer = createInstaller({
      root,
      exec: async (command, args) => {
        calls.push([command, ...args]);
        await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
        return { code: 0, output: '' };
      },
    });
    const captured = await installer.capture?.(parse(), ctx);
    expect(captured).toEqual({ kind: 'npm-shrinkwrap', content: '{"lockfileVersion":3}' });
    expect(calls[0]).toEqual(
      expect.arrayContaining(['npm', 'install', '--package-lock-only', '--ignore-scripts']),
    );
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toContain('@scope/server-x');
  });

  it('8.7 pypi capture runs uv pip compile --generate-hashes on requirements.in', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-capture-'));
    const calls: string[][] = [];
    const installer = createInstaller({
      root,
      exec: async (command, args) => {
        calls.push([command, ...args]);
        await writeFile(
          path.join(root, 'requirements.txt'),
          ['x==1 \\', '    --hash=sha256:aa', ''].join('\n'),
        );
        return { code: 0, output: '' };
      },
    });
    const captured = await installer.capture?.(
      parse({ runtime: 'pypi', identifier: 'mcp-server-fetch', version: '2026.8.18' }),
      ctx,
    );
    expect(captured?.kind).toBe('uv-requirements');
    expect(calls[0]).toEqual(expect.arrayContaining(['uv', 'pip', 'compile', '--generate-hashes']));
    expect(await readFile(path.join(root, 'requirements.in'), 'utf8')).toBe(
      'mcp-server-fetch==2026.8.18\n',
    );
  });

  it('8.7 a failing resolve reports the tail of the package manager output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-capture-'));
    const installer = createInstaller({
      root,
      exec: async () => ({ code: 1, output: 'npm error code ETARGET\nnpm error notarget' }),
    });
    await expect(installer.capture?.(parse(), ctx)).rejects.toThrow(/ETARGET/);
  });
});

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StartRequest } from '@bastion-mcp/sandbox/protocol';

/** Package installation (8.3 "Install"). Plans are pure data; execution goes through an injected runner. */

export const MCP_ROOT = '/opt/mcp';

export type PlannedCommand = { command: string; args: string[] };
export type InstallPlan = {
  /** Files to write, relative to the install root. */
  files: { path: string; content: string }[];
  commands: PlannedCommand[];
};

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export const sha256Hex = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** Throws when the lockfile content does not match its recorded SHA-256 (8.7). */
export const assertLockfileIntegrity = (lockfile: NonNullable<StartRequest['lockfile']>): void => {
  if (sha256Hex(lockfile.content) !== lockfile.sha256) {
    throw new InstallError('lockfile integrity check failed: sha256 mismatch');
  }
};

export const buildNpmPlan = (req: StartRequest, root: string = MCP_ROOT): InstallPlan => {
  const flags = ['--prefix', root, '--omit=dev', '--no-audit', '--no-fund'];
  if (!req.allowInstallScripts) flags.push('--ignore-scripts');
  const packageJson = JSON.stringify(
    {
      name: 'bastion-mcp-instance',
      version: '0.0.0',
      private: true,
      dependencies: { [req.identifier]: req.version },
    },
    null,
    2,
  );
  if (req.lockfile) {
    if (req.lockfile.kind !== 'npm-shrinkwrap') throw new InstallError('npm needs an npm-shrinkwrap lockfile');
    return {
      files: [
        { path: 'package.json', content: packageJson },
        { path: 'npm-shrinkwrap.json', content: req.lockfile.content },
      ],
      commands: [{ command: 'npm', args: ['ci', ...flags] }],
    };
  }
  return {
    files: [{ path: 'package.json', content: packageJson }],
    commands: [{ command: 'npm', args: ['install', ...flags, `${req.identifier}@${req.version}`] }],
  };
};

export const buildUvPlan = (req: StartRequest, root: string = MCP_ROOT): InstallPlan => {
  const venv = `${root}/.venv`;
  const python = `${venv}/bin/python`;
  const venvCmd: PlannedCommand = { command: 'uv', args: ['venv', venv, '--python', '3.13'] };
  if (req.lockfile) {
    if (req.lockfile.kind !== 'uv-requirements') throw new InstallError('pypi needs a uv-requirements lockfile');
    return {
      files: [{ path: 'requirements.txt', content: req.lockfile.content }],
      commands: [
        venvCmd,
        {
          command: 'uv',
          args: ['pip', 'install', '--python', python, '--require-hashes', '-r', `${root}/requirements.txt`],
        },
      ],
    };
  }
  return {
    files: [],
    commands: [
      venvCmd,
      { command: 'uv', args: ['pip', 'install', '--python', python, `${req.identifier}==${req.version}`] },
    ],
  };
};

export const buildInstallPlan = (req: StartRequest, root: string = MCP_ROOT): InstallPlan =>
  req.runtime === 'npm' ? buildNpmPlan(req, root) : buildUvPlan(req, root);

/** Picks the executable name from a package.json `bin` field (8.3: "resolve the binary from `bin`"). */
export const resolveNpmBinName = (
  packageJson: { name?: unknown; bin?: unknown },
  identifier: string,
  requested: string | undefined,
): string => {
  const unscoped = identifier.replace(/^@[^/]+\//, '');
  const { bin } = packageJson;
  if (typeof bin === 'string') {
    if (requested && requested !== unscoped) throw new InstallError(`package has no bin "${requested}"`);
    return unscoped;
  }
  if (typeof bin === 'object' && bin !== null) {
    const names = Object.keys(bin);
    if (requested) {
      if (!names.includes(requested)) throw new InstallError(`package has no bin "${requested}"`);
      return requested;
    }
    if (names.length === 1) return names[0] as string;
    if (names.includes(unscoped)) return unscoped;
    throw new InstallError(`package has several bins (${names.join(', ')}); set "bin"`);
  }
  throw new InstallError('package declares no bin');
};

export type ResolvedCommand = { command: string; args: string[] };
export type InstallContext = {
  signal: AbortSignal;
  /** Environment for installer subprocesses (proxy, mirrors, caches). */
  env: Record<string, string>;
  onDetail: (detail: string) => void;
};

export interface Installer {
  install(req: StartRequest, ctx: InstallContext): Promise<ResolvedCommand>;
}

export type ExecResult = { code: number | null; output: string };
export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
) => Promise<ExecResult>;

const MAX_OUTPUT_CHARS = 16 * 1024;

export const defaultExec: ExecFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

/** Environment for installer subprocesses: proxy plus mirrors (8.3, 8.7). Never the spec's server env. */
export const buildInstallEnv = (
  req: StartRequest,
  base: { path: string; home: string; passthrough?: Record<string, string> },
): Record<string, string> => ({
  ...(base.passthrough ?? {}),
  PATH: base.path,
  HOME: base.home,
  HTTPS_PROXY: req.egress.proxyUrl,
  HTTP_PROXY: req.egress.proxyUrl,
  NO_PROXY: '',
  npm_config_registry: req.registry.npm ?? 'https://registry.npmjs.org',
  npm_config_cache: '/tmp/npm-cache',
  npm_config_update_notifier: 'false',
  UV_INDEX_URL: req.registry.pypi ?? 'https://pypi.org/simple',
  UV_CACHE_DIR: '/tmp/uv-cache',
  UV_PYTHON_DOWNLOADS: 'never',
});

/** Replaces every secret (and its URL-encoded form) in `text`, so proxy credentials never reach events. */
export const redactSecrets = (text: string, secrets: readonly string[]): string =>
  secrets
    .filter((s) => s.length >= 4)
    .reduce(
      (acc, s) => acc.split(s).join('[redacted]').split(encodeURIComponent(s)).join('[redacted]'),
      text,
    );

export const createInstaller = (
  options: { root?: string; exec?: ExecFn } = {},
): Installer => {
  const root = options.root ?? MCP_ROOT;
  const exec = options.exec ?? defaultExec;
  return {
    async install(req, ctx) {
      if (req.lockfile) assertLockfileIntegrity(req.lockfile);
      const plan = buildInstallPlan(req, root);
      await mkdir(root, { recursive: true });
      for (const file of plan.files) {
        await writeFile(path.join(root, file.path), file.content, { mode: 0o600 });
      }
      for (const cmd of plan.commands) {
        ctx.onDetail(`${cmd.command} ${cmd.args[0] ?? ''}`.trim());
        const result = await exec(cmd.command, cmd.args, {
          cwd: root,
          env: ctx.env,
          signal: ctx.signal,
        });
        if (result.code !== 0) {
          throw new InstallError(
            `${cmd.command} ${cmd.args[0] ?? ''} failed (exit ${result.code}): ${result.output.slice(-2000)}`,
          );
        }
      }
      if (req.runtime === 'pypi') {
        return { command: `${root}/.venv/bin/${req.bin ?? req.identifier}`, args: req.args };
      }
      const pkgPath = path.join(root, 'node_modules', ...req.identifier.split('/'), 'package.json');
      let parsed: { name?: unknown; bin?: unknown };
      try {
        parsed = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: unknown; bin?: unknown };
      } catch {
        throw new InstallError(`installed package.json not found for ${req.identifier}`);
      }
      const bin = resolveNpmBinName(parsed, req.identifier, req.bin);
      return { command: path.join(root, 'node_modules', '.bin', bin), args: req.args };
    },
  };
};

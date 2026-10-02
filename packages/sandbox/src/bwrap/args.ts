import path from 'node:path';

/** Per-instance directory layout and the exact `bwrap` argv of 8.5. Pure. */

export type SandboxDirs = {
  root: string;
  workspace: string;
  home: string;
  mcp: string;
  run: string;
};

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/;

/** `$BASTION_DATA_DIR/sandboxes/<instanceId>/{workspace,home,mcp,run}` (8.5). */
export const sandboxDirs = (dataDir: string, instanceId: string): SandboxDirs => {
  if (!INSTANCE_ID.test(instanceId)) throw new TypeError(`invalid instance id "${instanceId}"`);
  const root = path.posix.join(dataDir, 'sandboxes', instanceId);
  return {
    root,
    workspace: `${root}/workspace`,
    home: `${root}/home`,
    mcp: `${root}/mcp`,
    run: `${root}/run`,
  };
};

export type BwrapOptions = {
  dirs: SandboxDirs;
  /** File descriptor carrying the seccomp BPF program (`--seccomp <fd>`). */
  seccompFd?: number;
  runtimeDir?: string;
  /** Path of the bundled runner inside the jail. */
  runnerPath?: string;
  /**
   * Also read-only bind the directory that holds `runnerPath`. The argv of 8.5 does not mount it, so the
   * runner would not exist inside the jail; the driver always enables this (see docs deviation).
   */
  bindRunnerDir?: boolean;
  /** `--symlink usr/lib64 /lib64`, needed for the dynamic loader on x86_64 Debian. */
  lib64?: boolean;
};

/** Argv of 8.5 for one jail, without the leading `bwrap`. */
export const buildBwrapArgs = (options: BwrapOptions): string[] => {
  const { dirs } = options;
  const runtime = options.runtimeDir ?? '/opt/runtime';
  const runnerPath = options.runnerPath ?? '/opt/bastion/runner.mjs';
  const args = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    runtime,
    runtime,
    ...(options.bindRunnerDir
      ? ['--ro-bind', path.posix.dirname(runnerPath), path.posix.dirname(runnerPath)]
      : []),
    '--symlink',
    'usr/lib',
    '/lib',
    ...(options.lib64 ? ['--symlink', 'usr/lib64', '/lib64'] : []),
    '--symlink',
    'usr/bin',
    '/bin',
    '--ro-bind',
    '/etc/ssl',
    '/etc/ssl',
    '--ro-bind',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    dirs.workspace,
    '/workspace',
    '--bind',
    dirs.home,
    '/home/sandbox',
    '--bind',
    dirs.mcp,
    '/opt/mcp',
    '--bind',
    dirs.run,
    '/run/bastion',
    '--clearenv',
    '--setenv',
    'HOME',
    '/home/sandbox',
    '--setenv',
    'PATH',
    `${runtime}/bin:/usr/bin`,
    '--seccomp',
    String(options.seccompFd ?? 3),
    `${runtime}/bin/node`,
    runnerPath,
    '--listen',
    'unix:/run/bastion/runner.sock',
    '--egress',
    'unix:/run/bastion/egress.sock',
  ];
  return args;
};

/** Wraps argv so the process joins a cgroup before `exec` (no race with early children). */
export const wrapWithCgroup = (cgroupProcsFile: string, argv: readonly string[]): string[] => [
  'sh',
  '-c',
  'echo $$ > "$0" && exec "$@"',
  cgroupProcsFile,
  ...argv,
];

/** `prlimit` fallback limits when no writable cgroup v2 subtree exists (8.5). */
export const PRLIMIT_ARGS = ['--nproc=256', '--nofile=1024'] as const;

export const wrapWithPrlimit = (argv: readonly string[]): string[] => [
  'prlimit',
  ...PRLIMIT_ARGS,
  '--',
  ...argv,
];

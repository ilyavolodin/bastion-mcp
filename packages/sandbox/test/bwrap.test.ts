import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BubblewrapDriver,
  buildBwrapArgs,
  type CgroupFs,
  CgroupManager,
  cgroupLimitsForSize,
  compileSeccomp,
  evaluateSeccomp,
  generateSeccompBpf,
  isolationSatisfies,
  knownSyscalls,
  parseCgroupV2Path,
  parseProcSample,
  probeBwrap,
  RssMonitor,
  type SandboxSpec,
  SECCOMP_AUDIT_ARCH,
  SECCOMP_RET,
  sandboxDirs,
  syscallNumber,
  treeRssBytes,
  wrapWithCgroup,
  wrapWithPrlimit,
} from '../src';

const profile = JSON.parse(
  readFileSync(new URL('../../../deploy/docker/sandbox-seccomp.json', import.meta.url), 'utf8'),
) as unknown;

describe('8.5 directory layout', () => {
  it('8.5 gives each instance workspace/, home/, mcp/ and run/ under $BASTION_DATA_DIR/sandboxes/<id>', () => {
    expect(sandboxDirs('/var/lib/bastion', '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toEqual({
      root: '/var/lib/bastion/sandboxes/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      workspace: '/var/lib/bastion/sandboxes/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/workspace',
      home: '/var/lib/bastion/sandboxes/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/home',
      mcp: '/var/lib/bastion/sandboxes/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/mcp',
      run: '/var/lib/bastion/sandboxes/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/run',
    });
  });
  it('8.5 rejects instance ids that could escape the data directory', () => {
    for (const bad of ['../etc', 'a/b', '', 'x', '..', 'a b c d e f', '-lead-dash-123']) {
      expect(() => sandboxDirs('/d', bad)).toThrow(TypeError);
    }
  });
});

describe('8.5 bwrap argv', () => {
  const dirs = sandboxDirs('/data', 'inst-0123456789');
  const spec = (d: string) => [
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
    '/opt/runtime',
    '/opt/runtime',
    '--symlink',
    'usr/lib',
    '/lib',
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
    `${d}/workspace`,
    '/workspace',
    '--bind',
    `${d}/home`,
    '/home/sandbox',
    '--bind',
    `${d}/mcp`,
    '/opt/mcp',
    '--bind',
    `${d}/run`,
    '/run/bastion',
    '--clearenv',
    '--setenv',
    'HOME',
    '/home/sandbox',
    '--setenv',
    'PATH',
    '/opt/runtime/bin:/usr/bin',
    '--seccomp',
    '3',
    '/opt/runtime/bin/node',
    '/opt/bastion/runner.mjs',
    '--listen',
    'unix:/run/bastion/runner.sock',
    '--egress',
    'unix:/run/bastion/egress.sock',
  ];

  it('8.5 produces exactly the documented argv', () => {
    expect(buildBwrapArgs({ dirs })).toEqual(spec(dirs.root));
  });
  it('8.5 --unshare-net, --die-with-parent, --cap-drop ALL and --clearenv are always present', () => {
    for (const opts of [{ dirs }, { dirs, bindRunnerDir: true, lib64: true }]) {
      const args = buildBwrapArgs(opts);
      expect(args).toEqual(
        expect.arrayContaining([
          '--unshare-net',
          '--die-with-parent',
          '--clearenv',
          '--new-session',
        ]),
      );
      expect(args.join(' ')).toContain('--cap-drop ALL');
      expect(args.indexOf('--seccomp')).toBeGreaterThan(args.indexOf('--clearenv'));
    }
  });
  it('8.5 deviation: the driver also binds the runner directory (the spec argv leaves the runner unmounted) and /lib64', () => {
    const args = buildBwrapArgs({ dirs, bindRunnerDir: true, lib64: true });
    expect(args.join(' ')).toContain('--ro-bind /opt/bastion /opt/bastion');
    expect(args.join(' ')).toContain('--symlink usr/lib64 /lib64');
    expect(args.slice(0, 16)).toEqual(spec(dirs.root).slice(0, 16));
  });
  it('8.5 never binds the host data dir root, only the four instance subdirectories', () => {
    const binds = buildBwrapArgs({ dirs })
      .map((a, i, all) => (a === '--bind' ? all[i + 1] : undefined))
      .filter(Boolean);
    expect(binds).toEqual([dirs.workspace, dirs.home, dirs.mcp, dirs.run]);
  });
  it('8.5 honours custom runtime and runner locations', () => {
    const args = buildBwrapArgs({
      dirs,
      runtimeDir: '/rt',
      runnerPath: '/x/runner.mjs',
      seccompFd: 7,
    });
    expect(args).toContain('/rt/bin/node');
    expect(args).toContain('/x/runner.mjs');
    expect(args[args.indexOf('--seccomp') + 1]).toBe('7');
  });
  it('8.5 wraps the argv with a cgroup join or prlimit', () => {
    expect(wrapWithCgroup('/sys/fs/cgroup/x/cgroup.procs', ['bwrap', '--a'])).toEqual([
      'sh',
      '-c',
      'echo $$ > "$0" && exec "$@"',
      '/sys/fs/cgroup/x/cgroup.procs',
      'bwrap',
      '--a',
    ]);
    expect(wrapWithPrlimit(['bwrap'])).toEqual([
      'prlimit',
      '--nproc=256',
      '--nofile=1024',
      '--',
      'bwrap',
    ]);
  });
});

describe('8.5 seccomp filter generated from deploy/docker/sandbox-seccomp.json', () => {
  const ARCHES = ['x86_64', 'aarch64'] as const;
  const DENIED = [
    'ptrace',
    'mount',
    'umount2',
    'keyctl',
    'bpf',
    'userfaultfd',
    'perf_event_open',
    'kexec_load',
    'kexec_file_load',
    'setns',
    'pivot_root',
    'chroot',
    'process_vm_readv',
    'init_module',
  ];
  const NS = [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000];

  for (const arch of ARCHES) {
    const program = compileSeccomp(profile, arch);
    const run = (nr: number, args: number[] = []) =>
      evaluateSeccomp(program, { nr, arch: SECCOMP_AUDIT_ARCH[arch], args });
    const EPERM = SECCOMP_RET.ERRNO | 1;

    it(`8.5 [${arch}] denies ptrace, mount, keyctl, bpf, userfaultfd, perf_event_open and kexec_* with EPERM`, () => {
      for (const name of DENIED) {
        const nr = syscallNumber(name, arch);
        expect(nr, name).toBeDefined();
        expect(run(nr as number), name).toBe(EPERM);
      }
    });
    it(`8.5 [${arch}] denies every namespace-creating clone/unshare flag and setns`, () => {
      for (const call of ['clone', 'unshare']) {
        const nr = syscallNumber(call, arch) as number;
        for (const flag of NS) expect(run(nr, [flag]), `${call} ${flag.toString(16)}`).toBe(EPERM);
        expect(run(nr, [(NS[4] as number) | 0x00000100]), 'combined flags').toBe(EPERM);
      }
    });
    it(`8.5 [${arch}] still allows thread-style clone, ordinary syscalls and denies clone3 with ENOSYS`, () => {
      const clone = syscallNumber('clone', arch) as number;
      expect(run(clone, [0x003d0f00])).toBe(SECCOMP_RET.ALLOW); // CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM...
      expect(run(clone, [0])).toBe(SECCOMP_RET.ALLOW);
      expect(run(0)).toBe(SECCOMP_RET.ALLOW); // read
      expect(run(1)).toBe(SECCOMP_RET.ALLOW); // write
      expect(run(syscallNumber('clone3', arch) as number)).toBe(SECCOMP_RET.ERRNO | 38);
    });
    it(`8.5 [${arch}] kills a process using another architecture's syscall ABI`, () => {
      const other = arch === 'x86_64' ? SECCOMP_AUDIT_ARCH.aarch64 : SECCOMP_AUDIT_ARCH.x86_64;
      expect(evaluateSeccomp(program, { nr: 0, arch: other })).toBe(SECCOMP_RET.KILL_PROCESS);
    });
  }

  it('8.5 x86_64: x32 ABI syscall numbers are killed so the denylist cannot be bypassed', () => {
    const program = compileSeccomp(profile, 'x86_64');
    expect(
      evaluateSeccomp(program, { nr: 0x40000000 | 101, arch: SECCOMP_AUDIT_ARCH.x86_64 }),
    ).toBe(SECCOMP_RET.KILL_PROCESS);
  });

  it('8.5 property: every syscall number outside the denylist is allowed', () => {
    const program = compileSeccomp(profile, 'x86_64');
    const denied = new Set(
      knownSyscalls()
        .map((n) => syscallNumber(n, 'x86_64'))
        .filter((n) => n !== undefined),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600 }), (nr) => {
        const r = evaluateSeccomp(program, {
          nr,
          arch: SECCOMP_AUDIT_ARCH.x86_64,
          args: [0, 0, 0, 0, 0, 0],
        });
        if (!denied.has(nr)) expect(r).toBe(SECCOMP_RET.ALLOW);
      }),
      { numRuns: 601 },
    );
  });

  it('8.5 serializes to sock_filter structs (8 bytes each) for the --seccomp fd', () => {
    const bytes = generateSeccompBpf(profile, 'aarch64');
    expect(bytes.length % 8).toBe(0);
    expect(bytes.readUInt16LE(0)).toBe(0x20);
    expect(bytes.length / 8).toBe(compileSeccomp(profile, 'aarch64').length);
    expect(bytes.length / 8).toBeLessThan(4096);
  });

  it('8.5 rejects a profile naming an unknown syscall (typos fail at startup)', () => {
    expect(() =>
      compileSeccomp(
        {
          defaultAction: 'SCMP_ACT_ALLOW',
          syscalls: [{ names: ['ptrase'], action: 'SCMP_ACT_ERRNO' }],
        },
        'x86_64',
      ),
    ).toThrow(/unknown syscall/);
    expect(() => compileSeccomp({ defaultAction: 'nope', syscalls: [] }, 'x86_64')).toThrow();
  });

  it('8.5 supports EQ conditions, kill actions and a default deny', () => {
    const p = compileSeccomp(
      {
        defaultAction: 'SCMP_ACT_ERRNO',
        defaultErrnoRet: 13,
        syscalls: [
          {
            names: ['ptrace'],
            action: 'SCMP_ACT_KILL_PROCESS',
            args: [{ index: 0, value: 5, op: 'SCMP_CMP_EQ' }],
          },
          { names: ['iopl'], action: 'SCMP_ACT_KILL' },
        ],
      },
      'aarch64',
    );
    const e = (nr: number, args: number[] = []) =>
      evaluateSeccomp(p, { nr, arch: SECCOMP_AUDIT_ARCH.aarch64, args });
    expect(e(117, [5])).toBe(SECCOMP_RET.KILL_PROCESS);
    expect(e(117, [6])).toBe(SECCOMP_RET.ERRNO | 13);
    expect(syscallNumber('iopl', 'aarch64')).toBeUndefined();
    expect(e(0)).toBe(SECCOMP_RET.ERRNO | 13);
  });

  it('8.5 evaluator guards against malformed programs', () => {
    expect(() => evaluateSeccomp([], { nr: 0, arch: 0 })).toThrow(/off the end/);
    expect(() => evaluateSeccomp([{ code: 0xff, jt: 0, jf: 0, k: 0 }], { nr: 0, arch: 0 })).toThrow(
      /opcode/,
    );
  });
});

describe('8.5 resource limits', () => {
  it('8.5 derives memory.max, cpu.max and pids.max from the size', () => {
    expect(cgroupLimitsForSize('small')).toEqual({
      'memory.max': String(512 * 1024 * 1024),
      'cpu.max': '100000 100000',
      'pids.max': '256',
    });
    expect(cgroupLimitsForSize('medium')['cpu.max']).toBe('200000 100000');
    expect(cgroupLimitsForSize('large')['memory.max']).toBe(String(4096 * 1024 * 1024));
  });

  const memFs = (opts: {
    writable: boolean;
  }): CgroupFs & { files: Map<string, string>; dirs: Set<string> } => {
    const files = new Map<string, string>([
      ['/proc/self/cgroup', '0::/docker/abc\n'],
      ['/sys/fs/cgroup/cgroup.controllers', 'cpu memory pids'],
    ]);
    const dirs = new Set<string>();
    return {
      files,
      dirs,
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: async (p, c) => void files.set(p, c),
      mkdir: async (p) => {
        if (!opts.writable) throw new Error('EROFS');
        dirs.add(p);
      },
      rmdir: async (p) => void dirs.delete(p),
    };
  };

  it('8.5 uses a child cgroup v2 when the subtree is writable and kills it on removal', async () => {
    const fs = memFs({ writable: true });
    const manager = await CgroupManager.detect(fs);
    expect(manager).not.toBeNull();
    const handle = await (manager as CgroupManager).create('inst-1', 'small');
    expect(handle.procsFile).toBe('/sys/fs/cgroup/docker/abc/bastion-inst-1/cgroup.procs');
    expect(fs.files.get('/sys/fs/cgroup/docker/abc/bastion-inst-1/memory.max')).toBe(
      String(512 * 1024 * 1024),
    );
    expect(fs.files.get('/sys/fs/cgroup/docker/abc/bastion-inst-1/pids.max')).toBe('256');
    await handle.remove();
    expect(fs.files.get('/sys/fs/cgroup/docker/abc/bastion-inst-1/cgroup.kill')).toBe('1');
    expect(fs.dirs.has('/sys/fs/cgroup/docker/abc/bastion-inst-1')).toBe(false);
    await expect((manager as CgroupManager).create('../x', 'small')).rejects.toThrow(TypeError);
  });
  it('8.5 falls back (null) when the cgroup subtree is read-only or v1', async () => {
    expect(await CgroupManager.detect(memFs({ writable: false }))).toBeNull();
    const fs = memFs({ writable: true });
    fs.files.set('/proc/self/cgroup', '12:memory:/x\n');
    expect(await CgroupManager.detect(fs)).toBeNull();
    const root = memFs({ writable: true });
    root.files.set('/proc/self/cgroup', '0::/\n');
    expect(await CgroupManager.detect(root)).not.toBeNull();
    expect(parseCgroupV2Path('0::/a/b\n')).toBe('/a/b');
  });

  it('8.5 sums RSS over the jail process tree and parses /proc samples', () => {
    const samples = [
      { pid: 10, ppid: 1, rssBytes: 100 },
      { pid: 11, ppid: 10, rssBytes: 50 },
      { pid: 12, ppid: 11, rssBytes: 25 },
      { pid: 20, ppid: 1, rssBytes: 999 },
    ];
    expect(treeRssBytes(samples, 10)).toBe(175);
    expect(treeRssBytes(samples, 99)).toBe(0);
    expect(parseProcSample(5, '5 (my (proc)) S 4 5 5 0', 'Name:\tx\nVmRSS:\t   2048 kB\n')).toEqual(
      { pid: 5, ppid: 4, rssBytes: 2048 * 1024 },
    );
    expect(parseProcSample(5, 'garbage', '')).toBeNull();
  });

  it('8.5 the RSS poller (every 2 s) kills the jail above its memory limit', async () => {
    let killed = 0;
    const monitor = new RssMonitor({
      rootPid: 10,
      limitBytes: 150,
      snapshot: async () => [
        { pid: 10, ppid: 1, rssBytes: 100 },
        { pid: 11, ppid: 10, rssBytes: 60 },
      ],
      onExceed: (rss) => {
        killed = rss;
      },
    });
    expect(await monitor.check()).toBe(true);
    expect(killed).toBe(160);
    const ok = new RssMonitor({
      rootPid: 10,
      limitBytes: 1000,
      snapshot: async () => [],
      onExceed: () => {
        throw new Error('no');
      },
    });
    expect(await ok.check()).toBe(false);
  });

  it('8.5 the RSS poller polls on an interval and stops after an exceed', async () => {
    let calls = 0;
    let exceeded = 0;
    const monitor = new RssMonitor({
      rootPid: 1,
      limitBytes: 10,
      intervalMs: 10,
      snapshot: async () => {
        calls += 1;
        return [{ pid: 1, ppid: 0, rssBytes: calls >= 2 ? 100 : 1 }];
      },
      onExceed: () => {
        exceeded += 1;
      },
    });
    monitor.start();
    monitor.start();
    await new Promise((r) => setTimeout(r, 120));
    monitor.stop();
    expect(exceeded).toBe(1);
    expect(calls).toBe(2);
  });
});

describe('8.5 startup probe', () => {
  it('8.5 reports available when `bwrap --unshare-user --unshare-net true` succeeds', async () => {
    const calls: string[][] = [];
    const result = await probeBwrap(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stderr: '' };
    });
    expect(result).toEqual({ status: 'available' });
    expect(calls).toEqual([['bwrap', '--unshare-user', '--unshare-net', 'true']]);
  });
  it('8.5 reports unavailable with the error text otherwise', async () => {
    expect(
      await probeBwrap(async () => ({
        code: 1,
        stderr: 'bwrap: No permissions to create new namespace\n',
      })),
    ).toEqual({
      status: 'unavailable',
      error: 'bwrap: No permissions to create new namespace',
    });
    expect(
      await probeBwrap(async () => ({ code: null, stderr: '', error: 'spawn bwrap ENOENT' })),
    ).toEqual({ status: 'unavailable', error: 'spawn bwrap ENOENT' });
    expect(await probeBwrap(async () => ({ code: 2, stderr: '' }))).toEqual({
      status: 'unavailable',
      error: 'exit code 2',
    });
  });
});

describe('8.5 isolation levels', () => {
  it('8.5 namespaces is below gvisor and kata, so minIsolation blocks the entry on bubblewrap', () => {
    expect(isolationSatisfies('namespaces', 'namespaces')).toBe(true);
    expect(isolationSatisfies('namespaces', 'gvisor')).toBe(false);
    expect(isolationSatisfies('namespaces', 'kata')).toBe(false);
    expect(isolationSatisfies('gvisor', 'namespaces')).toBe(true);
    expect(isolationSatisfies('kata', 'gvisor')).toBe(true);
  });
});

// --- driver with fakes ------------------------------------------------------------------------------------------
type FakeChild = EventEmitter & {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: unknown[];
  kill: (s?: string) => boolean;
  seccomp: Buffer[];
};
const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const seccomp = new PassThrough();
  child.seccomp = [];
  seccomp.on('data', (d: Buffer) => child.seccomp.push(d));
  child.stdio = [null, child.stdout, child.stderr, seccomp];
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  return child;
};

const SPEC: SandboxSpec = {
  instanceId: 'inst-0123456789',
  installationId: 'ins-1',
  userId: 'u1',
  size: 'small',
  workspace: { persistent: false, sizeMiB: 512 },
};

describe('8.5 bubblewrap driver', () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const spawned: { cmd: string; args: string[]; child: FakeChild }[] = [];
    const removed: string[] = [];
    const made: string[] = [];
    const egressSockets: string[] = [];
    let health = 0;
    const runnerCalls: string[] = [];
    const driver = new BubblewrapDriver({
      dataDir: '/data',
      seccompProfile: profile,
      arch: 'x86_64',
      probe: async () => ({ status: 'available' }),
      egress: {
        listenUnix: async (p) => {
          egressSockets.push(p);
          return { close: async () => void egressSockets.push(`closed:${p}`) };
        },
      },
      fs: {
        mkdir: async (p) => void made.push(p),
        rm: async (p) => void removed.push(p),
        readdir: async () => ['inst-0123456789', 'orphan-000000'],
      },
      spawn: ((cmd: string, args: string[]) => {
        const child = fakeChild();
        spawned.push({ cmd, args, child });
        return child;
      }) as never,
      runnerFactory: () => ({
        health: async () => {
          health += 1;
          if (health < 3) throw new Error('not yet');
          return { state: 'unbound' as const };
        },
        bind: async (t: string) => void runnerCalls.push(`bind:${t}`),
        useToken: (t: string) => void runnerCalls.push(`useToken:${t}`),
        start: async function* () {},
        stop: async () => {},
        openStdio: async () => {
          throw new Error('n/a');
        },
      }),
      tokenFactory: () => 'tok-fixed',
      readyTimeoutMs: 5_000,
      ...over,
    });
    return { driver, spawned, removed, made, egressSockets, runnerCalls };
  };

  it('8.5 create builds the layout, listens on the per-instance egress socket, spawns prlimit+bwrap with the BPF on fd 3, and binds', async () => {
    const t = setup();
    const handle = await t.driver.create(SPEC, new AbortController().signal);
    expect(t.made).toEqual([
      '/data/sandboxes/inst-0123456789/workspace',
      '/data/sandboxes/inst-0123456789/home',
      '/data/sandboxes/inst-0123456789/mcp',
      '/data/sandboxes/inst-0123456789/run',
    ]);
    expect(t.egressSockets).toEqual(['/data/sandboxes/inst-0123456789/run/egress.sock']);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]?.cmd).toBe('prlimit');
    expect(t.spawned[0]?.args.slice(0, 4)).toEqual(['--nproc=256', '--nofile=1024', '--', 'bwrap']);
    expect(t.spawned[0]?.args).toContain('--unshare-net');
    expect(Buffer.concat(t.spawned[0]?.child.seccomp ?? []).length).toBeGreaterThan(8);
    expect(t.runnerCalls).toEqual(['bind:tok-fixed']);
    expect(handle.ref).toEqual({
      driver: 'bubblewrap',
      id: 'inst-0123456789',
      address: 'unix:/data/sandboxes/inst-0123456789/run/runner.sock',
      runnerToken: 'tok-fixed',
    });
    expect(t.driver.name).toBe('bubblewrap');
    expect(t.driver.isolation).toBe('namespaces');
    await t.driver.close();
  });

  it('8.5 joins a cgroup (sh wrapper) when a writable cgroup v2 subtree exists', async () => {
    const files = new Map<string, string>([
      ['/proc/self/cgroup', '0::/\n'],
      ['/sys/fs/cgroup/cgroup.controllers', 'x'],
    ]);
    const manager = await CgroupManager.detect({
      readFile: async (p) =>
        files.get(p) ??
        (() => {
          throw new Error('ENOENT');
        })(),
      writeFile: async (p, c) => void files.set(p, c),
      mkdir: async () => {},
      rmdir: async () => {},
    });
    const t = setup({ cgroup: manager });
    await t.driver.create(SPEC, new AbortController().signal);
    expect(t.spawned[0]?.cmd).toBe('sh');
    expect(t.spawned[0]?.args[2]).toContain('/sys/fs/cgroup/bastion-inst-0123456789/cgroup.procs');
    expect(files.get('/sys/fs/cgroup/bastion-inst-0123456789/memory.max')).toBe(
      String(512 * 1024 * 1024),
    );
    await t.driver.close();
    expect(files.get('/sys/fs/cgroup/bastion-inst-0123456789/cgroup.kill')).toBe('1');
  });

  it('8.5 when bwrap is unavailable the start fails with the probe error text', async () => {
    const t = setup({
      probe: async () => ({
        status: 'unavailable',
        error: 'No permissions to create new namespace',
      }),
    });
    await expect(t.driver.create(SPEC, new AbortController().signal)).rejects.toMatchObject({
      code: 'SANDBOX_START_FAILED',
      message: expect.stringContaining('No permissions to create new namespace'),
    });
    expect(await t.driver.status()).toMatchObject({ status: 'unavailable' });
    expect(t.spawned).toHaveLength(0);
  });

  it('8.5 minIsolation gvisor or kata blocks the entry on the bubblewrap driver', async () => {
    const t = setup();
    await expect(
      t.driver.create({ ...SPEC, minIsolation: 'gvisor' }, new AbortController().signal),
    ).rejects.toThrow(/requires gvisor/);
    expect(t.spawned).toHaveLength(0);
  });

  it('8.5 a jail that exits before the runner is ready fails the start with its output and cleans up', async () => {
    const t = setup({
      runnerFactory: () => ({
        health: async () => {
          throw new Error('refused');
        },
        bind: async () => {},
        useToken: () => {},
        start: async function* () {},
        stop: async () => {},
        openStdio: async () => {
          throw new Error('n/a');
        },
      }),
      spawn: (() => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write('bwrap: setting up uid map: Permission denied');
          setTimeout(() => child.emit('exit', 1, null), 20);
        });
        return child;
      }) as never,
    });
    await expect(t.driver.create(SPEC, new AbortController().signal)).rejects.toThrow(
      /jail exited \(code 1/,
    );
    expect(t.egressSockets.some((s) => s.startsWith('closed:'))).toBe(true);
  });

  it('8.5 an aborted start kills the jail', async () => {
    const t = setup({
      runnerFactory: () => ({
        health: async () => {
          throw new Error('refused');
        },
        bind: async () => {},
        useToken: () => {},
        start: async function* () {},
        stop: async () => {},
        openStdio: async () => {
          throw new Error('n/a');
        },
      }),
    });
    const ctl = new AbortController();
    const pending = t.driver.create(SPEC, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toThrow(/did not become ready/);
  });

  it('8.2 attach returns a handle for a jail this worker owns and rejects unknown ones', async () => {
    const t = setup();
    const { ref } = await t.driver.create(SPEC, new AbortController().signal);
    const attached = await t.driver.attach(ref, new AbortController().signal);
    expect(attached.ref.id).toBe(ref.id);
    expect(t.runnerCalls).toContain('useToken:tok-fixed');
    await expect(
      t.driver.attach({ ...ref, id: 'gone-0123456' }, new AbortController().signal),
    ).rejects.toThrow(/not running/);
    await t.driver.close();
  });

  it('8.2 suspend stops the jail but keeps the directories; destroy removes them', async () => {
    const t = setup();
    const { ref } = await t.driver.create(SPEC, new AbortController().signal);
    await t.driver.suspend(ref);
    expect(t.removed).toEqual([]);
    expect(t.egressSockets).toContain('closed:/data/sandboxes/inst-0123456789/run/egress.sock');
    await t.driver.destroy(ref);
    expect(t.removed).toEqual(['/data/sandboxes/inst-0123456789']);
    await t.driver.suspend(ref); // idempotent
  });

  it('8.2 list yields every instance directory for garbage collection', async () => {
    const t = setup();
    await t.driver.create(SPEC, new AbortController().signal);
    const refs: string[] = [];
    for await (const r of t.driver.list()) refs.push(`${r.id}:${r.runnerToken}`);
    expect(refs).toEqual(['inst-0123456789:tok-fixed', 'orphan-000000:']);
    await t.driver.close();
  });

  it('8.2 refuses to create the same instance twice', async () => {
    const t = setup();
    await t.driver.create(SPEC, new AbortController().signal);
    await expect(t.driver.create(SPEC, new AbortController().signal)).rejects.toThrow(
      /already exists/,
    );
    await t.driver.close();
  });

  it('8.5 reports a jail exit and kills the jail above its RSS limit when no cgroup is available', async () => {
    const exits: string[] = [];
    const exceeded: number[] = [];
    const t = setup({
      processSnapshot: async () => [{ pid: 4242, ppid: 1, rssBytes: 600 * 1024 * 1024 }],
      onJailExit: (id: string, e: { signal: string | null }) =>
        void exits.push(`${id}:${e.signal}`),
      onRssExceeded: (_id: string, rss: number) => void exceeded.push(rss),
    });
    await t.driver.create(SPEC, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(exceeded).toEqual([600 * 1024 * 1024]);
    expect(exits).toEqual(['inst-0123456789:SIGKILL']);
    await t.driver.close();
  }, 10_000);

  it('8.5 the default listing tolerates a missing sandboxes directory', async () => {
    const t = setup({
      fs: {
        mkdir: async () => {},
        rm: async () => {},
        readdir: async () => {
          throw new Error('ENOENT');
        },
      },
    });
    const refs = [];
    for await (const r of t.driver.list()) refs.push(r);
    expect(refs).toEqual([]);
  });

  it('8.5 a bad seccomp profile fails at construction, not on first start', () => {
    expect(
      () =>
        new BubblewrapDriver({
          dataDir: '/d',
          seccompProfile: { defaultAction: 'x', syscalls: [] },
          egress: { listenUnix: async () => ({ close: async () => {} }) },
        }),
    ).toThrow();
  });
});

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { SandboxStartFailedError } from '@bastion-mcp/core';
import { HttpRunnerClient, parseRunnerAddress } from '../runner-client';
import type {
  IsolationLevel,
  RunnerClient,
  SandboxDriver,
  SandboxHandle,
  SandboxRef,
  SandboxSpec,
} from '../types';
import {
  buildBwrapArgs,
  type SandboxDirs,
  sandboxDirs,
  wrapWithCgroup,
  wrapWithPrlimit,
} from './args';
import {
  type CgroupHandle,
  type CgroupManager,
  memoryLimitBytes,
  type ProcessSample,
  RssMonitor,
} from './limits';
import { type ProbeResult, probeBwrap } from './probe';
import { compileSeccomp, hostSeccompArch, type SeccompArch, serializeBpf } from './seccomp';

export const ISOLATION_RANK: Record<IsolationLevel, number> = { namespaces: 0, gvisor: 1, kata: 2 };

/** `minIsolation` of a catalog entry blocks entries the driver cannot satisfy (8.5). */
export const isolationSatisfies = (actual: IsolationLevel, minimum: IsolationLevel): boolean =>
  ISOLATION_RANK[actual] >= ISOLATION_RANK[minimum];

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface DriverFs {
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const nodeDriverFs: DriverFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  rm: (path) => rm(path, { recursive: true, force: true }),
  readdir: (path) => readdir(path),
};

/** The egress proxy side: one Unix socket per instance (8.8). `EgressProxy` satisfies this. */
export interface InstanceEgressListener {
  listenUnix(socketPath: string, instanceId: string): Promise<{ close(): Promise<void> }>;
}

export type BubblewrapDriverOptions = {
  /** `BASTION_DATA_DIR` */
  dataDir: string;
  /** Parsed `deploy/docker/sandbox-seccomp.json`. */
  seccompProfile: unknown;
  egress: InstanceEgressListener;
  probe?: () => Promise<ProbeResult>;
  spawn?: SpawnFn;
  fs?: DriverFs;
  /** From `CgroupManager.detect`; null or undefined selects `prlimit` + RSS polling. */
  cgroup?: CgroupManager | null;
  processSnapshot?: () => Promise<ProcessSample[]>;
  runnerPath?: string;
  runtimeDir?: string;
  lib64?: boolean;
  arch?: SeccompArch;
  readyTimeoutMs?: number;
  tokenFactory?: () => string;
  runnerFactory?: (address: string) => RunnerClient;
  /** Called when a jail's runner process exits (crash handling is the instance manager's job). */
  onJailExit?: (instanceId: string, exit: { code: number | null; signal: string | null }) => void;
  onRssExceeded?: (instanceId: string, rssBytes: number) => void;
};

type Jail = {
  instanceId: string;
  dirs: SandboxDirs;
  child: ChildProcess;
  egress: { close(): Promise<void> };
  cgroup: CgroupHandle | undefined;
  monitor: RssMonitor | undefined;
  runnerToken: string;
  address: string;
  exited: Promise<void>;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Single-container driver: each sandbox is a `bwrap` jail (8.5). Isolation level `namespaces`. */
export class BubblewrapDriver implements SandboxDriver {
  readonly name = 'bubblewrap' as const;
  readonly isolation: IsolationLevel = 'namespaces';
  private readonly jails = new Map<string, Jail>();
  private availability: Promise<ProbeResult> | undefined;
  private readonly bpf: Buffer;
  private readonly fs: DriverFs;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly options: BubblewrapDriverOptions) {
    // Generated once at startup from the profile; a bad profile fails here, not on the first start.
    this.bpf = serializeBpf(
      compileSeccomp(options.seccompProfile, options.arch ?? hostSeccompArch()),
    );
    this.fs = options.fs ?? nodeDriverFs;
    this.spawnFn = options.spawn ?? nodeSpawn;
  }

  /** Startup probe result (`unavailable` with the error text disables package installations in the UI). */
  status(): Promise<ProbeResult> {
    this.availability ??= (this.options.probe ?? (() => probeBwrap()))();
    return this.availability;
  }

  private fail(
    spec: { instanceId: string; installationId: string | null },
    message: string,
  ): never {
    throw new SandboxStartFailedError(message, {
      installation: spec.installationId ?? spec.instanceId,
      phase: 'claiming',
    });
  }

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
    const status = await this.status();
    if (status.status === 'unavailable') this.fail(spec, `bubblewrap unavailable: ${status.error}`);
    if (spec.minIsolation && !isolationSatisfies(this.isolation, spec.minIsolation)) {
      this.fail(
        spec,
        `catalog entry requires ${spec.minIsolation} isolation; this driver provides ${this.isolation}`,
      );
    }
    if (this.jails.has(spec.instanceId))
      this.fail(spec, 'sandbox already exists for this instance');
    const dirs = sandboxDirs(this.options.dataDir, spec.instanceId);
    for (const dir of [dirs.workspace, dirs.home, dirs.mcp, dirs.run]) await this.fs.mkdir(dir);

    const egress = await this.options.egress.listenUnix(`${dirs.run}/egress.sock`, spec.instanceId);
    let cgroup: CgroupHandle | undefined;
    try {
      const bwrapArgs = buildBwrapArgs({
        dirs,
        seccompFd: 3,
        bindRunnerDir: true,
        lib64: this.options.lib64 ?? (this.options.arch ?? hostSeccompArch()) === 'x86_64',
        ...(this.options.runnerPath ? { runnerPath: this.options.runnerPath } : {}),
        ...(this.options.runtimeDir ? { runtimeDir: this.options.runtimeDir } : {}),
      });
      let argv = ['bwrap', ...bwrapArgs];
      const manager = this.options.cgroup;
      if (manager) {
        cgroup = await manager.create(spec.instanceId, spec.size);
        argv = wrapWithCgroup(cgroup.procsFile, argv);
      } else {
        argv = wrapWithPrlimit(argv);
      }
      const [command, ...args] = argv as [string, ...string[]];
      const child = this.spawnFn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
      const sink = child.stdio[3];
      if (!sink || !('write' in sink)) throw new Error('seccomp pipe unavailable');
      sink.on('error', () => {});
      sink.end(this.bpf);

      let tail = '';
      const collect = (chunk: Buffer): void => {
        tail = (tail + chunk.toString('utf8')).slice(-4096);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      let exitInfo: { code: number | null; signal: string | null } | undefined;
      const exited = new Promise<void>((resolve) => {
        child.once('exit', (code, sig) => {
          exitInfo = { code, signal: sig };
          this.options.onJailExit?.(spec.instanceId, exitInfo);
          resolve();
        });
        child.once('error', () => resolve());
      });

      const address = `unix:${dirs.run}/runner.sock`;
      const runner = this.makeRunner(address);
      const deadline = AbortSignal.timeout(this.options.readyTimeoutMs ?? 30_000);
      const stop = AbortSignal.any([signal, deadline]);
      let ready = false;
      while (!stop.aborted && !exitInfo) {
        try {
          await runner.health(stop);
          ready = true;
          break;
        } catch {
          await sleep(100, stop);
        }
      }
      if (!ready) {
        const earlyExit = exitInfo;
        child.kill('SIGKILL');
        await exited;
        throw new Error(
          earlyExit
            ? `jail exited (code ${earlyExit.code}, signal ${earlyExit.signal}): ${tail.trim()}`
            : `runner did not become ready: ${tail.trim()}`,
        );
      }
      const runnerToken = (this.options.tokenFactory ?? (() => randomBytes(32).toString('hex')))();
      await runner.bind(runnerToken, stop);

      let monitor: RssMonitor | undefined;
      if (!manager && child.pid !== undefined && this.options.processSnapshot) {
        monitor = new RssMonitor({
          rootPid: child.pid,
          limitBytes: memoryLimitBytes(spec.size),
          snapshot: this.options.processSnapshot,
          onExceed: (rss) => {
            this.options.onRssExceeded?.(spec.instanceId, rss);
            child.kill('SIGKILL');
          },
        });
        monitor.start();
      }
      const jail: Jail = {
        instanceId: spec.instanceId,
        dirs,
        child,
        egress,
        cgroup,
        monitor,
        runnerToken,
        address,
        exited,
      };
      this.jails.set(spec.instanceId, jail);
      void exited.then(() => {
        jail.monitor?.stop();
      });
      return { ref: this.refOf(jail), runner };
    } catch (error) {
      await egress.close().catch(() => {});
      await cgroup?.remove();
      if (error instanceof SandboxStartFailedError) throw error;
      return this.fail(
        spec,
        `bubblewrap start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private makeRunner(address: string): RunnerClient {
    return this.options.runnerFactory
      ? this.options.runnerFactory(address)
      : new HttpRunnerClient(parseRunnerAddress(address));
  }

  private refOf(jail: Jail): SandboxRef {
    return {
      driver: 'bubblewrap',
      id: jail.instanceId,
      address: jail.address,
      runnerToken: jail.runnerToken,
    };
  }

  /** A jail dies with the container, so re-attach only works for jails this process owns. */
  async attach(ref: SandboxRef, _signal: AbortSignal): Promise<SandboxHandle> {
    const jail = this.jails.get(ref.id);
    if (!jail) {
      throw new SandboxStartFailedError('bubblewrap sandbox is not running in this container', {
        installation: ref.id,
        phase: 'claiming',
      });
    }
    const runner = this.makeRunner(jail.address);
    runner.useToken(jail.runnerToken);
    return { ref: this.refOf(jail), runner };
  }

  private async stopJail(instanceId: string): Promise<void> {
    const jail = this.jails.get(instanceId);
    if (!jail) return;
    this.jails.delete(instanceId);
    jail.monitor?.stop();
    jail.child.kill('SIGKILL');
    await Promise.race([jail.exited, new Promise<void>((r) => setTimeout(r, 5_000).unref())]);
    await jail.egress.close().catch(() => {});
    await jail.cgroup?.remove();
  }

  /** Stops the jail and keeps its directories, so a persistent workspace survives. */
  async suspend(ref: SandboxRef): Promise<void> {
    await this.stopJail(ref.id);
  }

  async destroy(ref: SandboxRef): Promise<void> {
    await this.stopJail(ref.id);
    await this.fs.rm(sandboxDirs(this.options.dataDir, ref.id).root);
  }

  /** Every instance directory on disk (live jails and leftovers), for garbage collection. */
  async *list(): AsyncIterable<SandboxRef> {
    let ids: string[];
    try {
      ids = await this.fs.readdir(`${this.options.dataDir}/sandboxes`);
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const jail = this.jails.get(id);
      yield {
        driver: 'bubblewrap',
        id,
        address: jail?.address ?? `unix:${this.options.dataDir}/sandboxes/${id}/run/runner.sock`,
        runnerToken: jail?.runnerToken ?? '',
      };
    }
  }

  /** Stops every jail; called on worker shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.jails.keys()].map((id) => this.stopJail(id)));
  }
}

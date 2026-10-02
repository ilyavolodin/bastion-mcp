import { SANDBOX_SIZES, type SandboxSize } from '@bastion-mcp/core';

/** Resource limits for jails (8.5): cgroup v2 when writable, otherwise prlimit plus RSS polling. */

const PIDS_BY_SIZE: Record<SandboxSize, number> = { small: 256, medium: 512, large: 1024 };
export const RSS_POLL_INTERVAL_MS = 2_000;
const CPU_PERIOD_US = 100_000;

export type CgroupLimits = { 'memory.max': string; 'cpu.max': string; 'pids.max': string };

/** `memory.max`, `cpu.max` and `pids.max` for a size (8.4 sizes, 8.5). */
export const cgroupLimitsForSize = (size: SandboxSize): CgroupLimits => {
  const s = SANDBOX_SIZES[size];
  return {
    'memory.max': String(s.memoryMiB * 1024 * 1024),
    'cpu.max': `${Math.round(s.cpuLimit * CPU_PERIOD_US)} ${CPU_PERIOD_US}`,
    'pids.max': String(PIDS_BY_SIZE[size]),
  };
};

export const memoryLimitBytes = (size: SandboxSize): number =>
  SANDBOX_SIZES[size].memoryMiB * 1024 * 1024;

/** File operations the cgroup manager needs; the real one wraps `node:fs/promises`. */
export interface CgroupFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/** Extracts the cgroup v2 path from `/proc/self/cgroup` (`0::/path`). */
export const parseCgroupV2Path = (procSelfCgroup: string): string | null => {
  const line = procSelfCgroup.split('\n').find((l) => l.startsWith('0::'));
  return line ? line.slice(3).trim() : null;
};

export type CgroupHandle = { procsFile: string; remove(): Promise<void> };

export class CgroupManager {
  private constructor(
    private readonly fs: CgroupFs,
    private readonly base: string,
  ) {}

  /**
   * Detects a writable cgroup v2 subtree for this container: the unified hierarchy must be mounted and a
   * child directory must be creatable. Returns null when only the `prlimit` fallback is possible.
   */
  static async detect(fs: CgroupFs, root = '/sys/fs/cgroup'): Promise<CgroupManager | null> {
    try {
      const own = parseCgroupV2Path(await fs.readFile('/proc/self/cgroup'));
      if (own === null) return null;
      await fs.readFile(`${root}/cgroup.controllers`);
      const base = `${root}${own === '/' ? '' : own}`;
      const probe = `${base}/bastion-probe-${process.pid}`;
      await fs.mkdir(probe);
      await fs.rmdir(probe);
      return new CgroupManager(fs, base);
    } catch {
      return null;
    }
  }

  async create(name: string, size: SandboxSize): Promise<CgroupHandle> {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new TypeError('invalid cgroup name');
    const dir = `${this.base}/bastion-${name}`;
    await this.fs.mkdir(dir);
    for (const [file, value] of Object.entries(cgroupLimitsForSize(size))) {
      await this.fs.writeFile(`${dir}/${file}`, value);
    }
    return {
      procsFile: `${dir}/cgroup.procs`,
      remove: async () => {
        // `cgroup.kill` (Linux 5.14+) ends every process of the jail before the directory is removed.
        await this.fs.writeFile(`${dir}/cgroup.kill`, '1').catch(() => {});
        await this.fs.rmdir(dir).catch(() => {});
      },
    };
  }
}

// --- RSS polling fallback -------------------------------------------------------------------------------------
export type ProcessSample = { pid: number; ppid: number; rssBytes: number };

/** Sum of RSS of `rootPid` and all its descendants in a process table snapshot. */
export const treeRssBytes = (samples: readonly ProcessSample[], rootPid: number): number => {
  const children = new Map<number, ProcessSample[]>();
  for (const sample of samples) {
    const list = children.get(sample.ppid) ?? [];
    list.push(sample);
    children.set(sample.ppid, list);
  }
  const byPid = new Map(samples.map((s) => [s.pid, s]));
  let total = byPid.get(rootPid)?.rssBytes ?? 0;
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const next = stack.pop() as ProcessSample;
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    total += next.rssBytes;
    stack.push(...(children.get(next.pid) ?? []));
  }
  return total;
};

/** Parses `/proc/<pid>/stat` + `status` content into a sample. */
export const parseProcSample = (
  pid: number,
  stat: string,
  status: string,
): ProcessSample | null => {
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  if (!Number.isInteger(ppid)) return null;
  return { pid, ppid, rssBytes: rss ? Number(rss[1]) * 1024 : 0 };
};

export class RssMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      rootPid: number;
      limitBytes: number;
      snapshot: () => Promise<ProcessSample[]>;
      onExceed: (rssBytes: number) => void;
      intervalMs?: number;
    },
  ) {}

  /** One poll; exposed for tests. Returns true when the limit was exceeded. */
  async check(): Promise<boolean> {
    const rss = treeRssBytes(await this.options.snapshot(), this.options.rootPid);
    if (rss > this.options.limitBytes) {
      this.options.onExceed(rss);
      return true;
    }
    return false;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().then(
        (exceeded) => {
          if (exceeded) this.stop();
        },
        () => {},
      );
    }, this.options.intervalMs ?? RSS_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

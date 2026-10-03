import { type ChildProcess, spawn } from 'node:child_process';
import type { JsonObject } from '@bastion-mcp/sandbox/protocol';
import { classifyStdoutLine, LineSplitter } from './lines';

/** SIGTERM to SIGKILL grace for the server process (8.3: 5 s). */
export const DEFAULT_KILL_GRACE_MS = 5000;

export type SpawnSpec = {
  command: string;
  args: readonly string[];
  /** The spec's environment variables (already resolved by the worker). */
  env: Readonly<Record<string, string>>;
  proxyUrl: string;
  cwd: string;
  home: string;
  path: string;
};

/**
 * Clean environment for the server process (8.3): only the spec's env plus HOME, PATH, the proxy variables
 * and `NO_PROXY=`. Reserved names always win over the spec's values.
 */
export const buildServerEnv = (spec: SpawnSpec): Record<string, string> => ({
  ...spec.env,
  HOME: spec.home,
  PATH: spec.path,
  HTTPS_PROXY: spec.proxyUrl,
  HTTP_PROXY: spec.proxyUrl,
  NO_PROXY: '',
});

export type ServerCallbacks = {
  onMessage: (message: JsonObject) => void;
  onStderr: (line: string) => void;
  onExit: (exit: { code: number | null; signal: string | null }) => void;
};

/** One MCP server child process speaking line-delimited JSON-RPC on stdio. */
export class ServerProcess {
  private child: ChildProcess | undefined;
  private exited = false;
  private readonly exitWaiters: (() => void)[] = [];

  constructor(
    private readonly spec: SpawnSpec,
    private readonly callbacks: ServerCallbacks,
  ) {}

  get isRunning(): boolean {
    return this.child !== undefined && !this.exited;
  }

  /** Resolves once the process has spawned; rejects when it cannot (ENOENT, EACCES, ...). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.command, [...this.spec.args], {
        cwd: this.spec.cwd,
        env: buildServerEnv(this.spec),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const stdout = new LineSplitter();
      const stderr = new LineSplitter();
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of stdout.push(chunk)) this.handleStdout(line);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of stderr.push(chunk)) this.callbacks.onStderr(line);
      });
      child.stdin?.on('error', () => {
        // The process went away; the exit event reports it.
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        if (!this.exited) {
          this.exited = true;
          this.notifyExitWaiters();
        }
        reject(error);
      });
      child.once('close', (code, signal) => {
        const tailOut = stdout.flush();
        if (tailOut) this.handleStdout(tailOut);
        const tailErr = stderr.flush();
        if (tailErr) this.callbacks.onStderr(tailErr);
        this.exited = true;
        this.callbacks.onExit({ code, signal });
        this.notifyExitWaiters();
      });
    });
  }

  private handleStdout(line: string): void {
    const parsed = classifyStdoutLine(line);
    if (parsed.kind === 'message') this.callbacks.onMessage(parsed.message);
    else if (parsed.kind === 'stderr') this.callbacks.onStderr(parsed.text);
  }

  /** Writes one JSON-RPC message to the server's stdin. Returns false when the process is gone. */
  write(message: JsonObject): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** SIGTERM, then SIGKILL after `graceMs` (8.3: 5 s). Resolves once the process is gone. */
  stop(graceMs = DEFAULT_KILL_GRACE_MS): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      timer.unref();
      this.exitWaiters.push(() => clearTimeout(timer));
    });
  }

  private notifyExitWaiters(): void {
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
}

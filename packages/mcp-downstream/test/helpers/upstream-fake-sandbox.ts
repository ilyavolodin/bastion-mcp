import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  JsonObject,
  RunnerClient,
  SandboxDriver,
  SandboxHandle,
  SandboxRef,
  SandboxSpec,
  StartEvent,
  StartRequestInput,
  StdioChannel,
  StdioHandlers,
} from '@bastion-mcp/sandbox';
import { fakeStdioServerPath } from '@bastion-mcp/testkit';

/**
 * A sandbox driver whose "sandboxes" are real child processes running the stdio fake MCP server, behind the same
 * contracts as the real runner: one WebSocket-like channel at a time (a new one replaces the old with code 4001),
 * a runner token, `/v1/start` phases and an exit frame when the process dies (8.3).
 */

type Event =
  | { kind: 'onmessage'; arg: JsonObject }
  | { kind: 'onstderr'; arg: string }
  | { kind: 'onexit'; arg: { code: number | null; signal: string | null } }
  | { kind: 'onclose'; arg: { code: number; reason: string } };

class FakeChannel implements StdioChannel {
  dropped = 0;
  private current: StdioHandlers = {};
  private pending: Event[] = [];
  closed = false;

  constructor(private readonly sandbox: FakeSandbox) {}

  get handlers(): StdioHandlers {
    return this.current;
  }

  set handlers(value: StdioHandlers) {
    this.current = value;
    const queued = this.pending;
    this.pending = [];
    for (const event of queued) this.dispatch(event);
  }

  dispatch(event: Event): void {
    const handler = this.current[event.kind] as ((arg: never) => void) | undefined;
    if (handler) handler(event.arg as never);
    else this.pending.push(event);
  }

  async send(message: JsonObject): Promise<void> {
    if (this.closed) throw new Error('stdio channel is not open');
    this.sandbox.process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dispatch({ kind: 'onclose', arg: { code: 1000, reason: '' } });
  }

  replaced(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatch({ kind: 'onclose', arg: { code: 4001, reason: 'replaced' } });
  }
}

export class FakeSandbox {
  token = '';
  state: 'unbound' | 'bound' | 'running' = 'unbound';
  process: ChildProcessWithoutNullStreams | undefined;
  channel: FakeChannel | undefined;
  startRequest: StartRequestInput | undefined;
  readonly stderr: string[] = [];
  readonly startedAt = Date.now();
  destroyed = false;

  constructor(readonly id: string) {}

  spawn(): void {
    const child = spawn(process.execPath, [fakeStdioServerPath], { stdio: 'pipe' });
    this.process = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.channel?.dispatch({ kind: 'onmessage', arg: JSON.parse(line) as JsonObject });
      } catch {
        // ignore noise
      }
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderr.push(line);
      this.channel?.dispatch({ kind: 'onstderr', arg: line });
    });
    child.on('exit', (code, signal) => {
      this.state = 'bound';
      this.channel?.dispatch({ kind: 'onexit', arg: { code, signal } });
    });
    this.state = 'running';
  }

  kill(): void {
    this.process?.kill();
  }
}

class FakeRunner implements RunnerClient {
  constructor(
    private readonly sandbox: FakeSandbox,
    private readonly driver: FakeSandboxDriver,
  ) {}

  async health(): Promise<{ state: 'unbound' | 'bound' | 'running' }> {
    if (this.sandbox.destroyed) throw new Error('sandbox is gone');
    return { state: this.sandbox.state };
  }

  async bind(token: string): Promise<void> {
    this.sandbox.token = token;
    this.sandbox.state = 'bound';
  }

  useToken(token: string): void {
    if (token !== this.sandbox.token) throw new Error('wrong runner token');
  }

  async *start(request: StartRequestInput): AsyncIterable<StartEvent> {
    this.sandbox.startRequest = request;
    this.driver.startRequests.push(request);
    if (this.driver.startDelayMs > 0)
      await new Promise((r) => setTimeout(r, this.driver.startDelayMs));
    yield { phase: 'installing', detail: 'npm ci', elapsedMs: 1 };
    if (this.driver.failStart !== undefined) {
      yield { phase: 'failed', detail: this.driver.failStart, elapsedMs: 2 };
      return;
    }
    yield { phase: 'starting', detail: 'spawn', elapsedMs: 3 };
    this.sandbox.spawn();
    yield { phase: 'ready', detail: 'ok', elapsedMs: 4 };
  }

  async stop(): Promise<void> {
    this.sandbox.kill();
  }

  async openStdio(): Promise<StdioChannel> {
    this.sandbox.channel?.replaced();
    const channel = new FakeChannel(this.sandbox);
    this.sandbox.channel = channel;
    return channel;
  }
}

export class FakeSandboxDriver implements SandboxDriver {
  readonly name = 'bubblewrap' as const;
  readonly isolation = 'namespaces' as const;
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly specs: SandboxSpec[] = [];
  readonly startRequests: StartRequestInput[] = [];
  readonly destroyed: string[] = [];
  readonly suspended: string[] = [];
  createCount = 0;
  attachCount = 0;
  /** When set, `/v1/start` ends with a `failed` phase carrying this detail. */
  failStart: string | undefined;
  startDelayMs = 0;
  private counter = 0;

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.createCount += 1;
    this.specs.push(spec);
    this.counter += 1;
    const sandbox = new FakeSandbox(`bst-${this.counter}`);
    this.sandboxes.set(sandbox.id, sandbox);
    const runner = new FakeRunner(sandbox, this);
    const runnerToken = `token-${this.counter}-${'x'.repeat(24)}`;
    await runner.bind(runnerToken);
    return {
      ref: {
        driver: 'bubblewrap',
        id: sandbox.id,
        address: `unix:/tmp/${sandbox.id}`,
        runnerToken,
      },
      runner,
    };
  }

  async attach(ref: SandboxRef): Promise<SandboxHandle> {
    this.attachCount += 1;
    const sandbox = this.sandboxes.get(ref.id);
    if (!sandbox || sandbox.destroyed) throw new Error('no such sandbox');
    const runner = new FakeRunner(sandbox, this);
    runner.useToken(ref.runnerToken);
    return { ref, runner };
  }

  async suspend(ref: SandboxRef): Promise<void> {
    this.suspended.push(ref.id);
    this.sandboxes.get(ref.id)?.kill();
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.destroyed.push(ref.id);
    const sandbox = this.sandboxes.get(ref.id);
    if (sandbox) {
      sandbox.destroyed = true;
      sandbox.kill();
    }
  }

  async *list(): AsyncIterable<SandboxRef> {
    for (const sandbox of this.sandboxes.values()) {
      yield { driver: 'bubblewrap', id: sandbox.id, address: '', runnerToken: '' };
    }
  }

  killAll(): void {
    for (const sandbox of this.sandboxes.values()) sandbox.kill();
  }
}

import http from 'node:http';
import { SandboxStartFailedError } from '@bastion-mcp/core';
import { WebSocket } from 'ws';
import {
  DROPPED_HEADER,
  decodeFrame,
  healthResponseSchema,
  type JsonObject,
  messageFrame,
  STDIO_SUBPROTOCOL,
  type StartEvent,
  type StartRequestInput,
  startEventSchema,
} from './protocol';
import { SANDBOX_TIMEOUTS_MS } from './timeouts';
import type { RunnerClient, StdioChannel, StdioHandlers } from './types';

export type RunnerTarget =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; socketPath: string };

/** Parses `host:port` or `unix:<path>` (the `SandboxRef.address` format). */
export const parseRunnerAddress = (address: string): RunnerTarget => {
  if (address.startsWith('unix:')) return { kind: 'unix', socketPath: address.slice(5) };
  const i = address.lastIndexOf(':');
  const port = Number(address.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`invalid runner address "${address}"`);
  }
  return { kind: 'tcp', host: address.slice(0, i).replace(/^\[|\]$/g, ''), port };
};

export class RunnerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerHttpError';
  }
}

const requestOptions = (target: RunnerTarget): http.RequestOptions =>
  target.kind === 'unix'
    ? { socketPath: target.socketPath, host: 'runner' }
    : { host: target.host, port: target.port };

const DEFAULT_TIMEOUT_MS = SANDBOX_TIMEOUTS_MS.runnerRequest;

type RawResponse = { status: number; body: string };

type ChannelEvent =
  | { kind: 'onmessage'; arg: JsonObject }
  | { kind: 'onstderr'; arg: string }
  | { kind: 'onexit'; arg: { code: number | null; signal: string | null } }
  | { kind: 'onclose'; arg: { code: number; reason: string } }
  | { kind: 'onerror'; arg: Error };

const MAX_PENDING_EVENTS = 10_000;

class WsStdioChannel implements StdioChannel {
  private current: StdioHandlers = {};
  private pending: ChannelEvent[] = [];

  constructor(
    private readonly ws: WebSocket,
    readonly dropped: number,
  ) {
    ws.on('message', (data: Buffer) => {
      const decoded = decodeFrame(data.toString('utf8'), 'toWorker');
      if (!decoded.ok) {
        this.dispatch({
          kind: 'onerror',
          arg: new Error(`runner sent an invalid frame: ${decoded.reason}`),
        });
        return;
      }
      const { frame } = decoded;
      if (frame.t === 'm') this.dispatch({ kind: 'onmessage', arg: frame.d });
      else if (frame.t === 'e') this.dispatch({ kind: 'onstderr', arg: frame.d });
      else this.dispatch({ kind: 'onexit', arg: { code: frame.code, signal: frame.signal } });
    });
    ws.on('close', (code: number, reason: Buffer) =>
      this.dispatch({ kind: 'onclose', arg: { code, reason: reason.toString('utf8') } }),
    );
    ws.on('error', (error: Error) => this.dispatch({ kind: 'onerror', arg: error }));
  }

  /** Events that arrive before a matching handler is installed are queued and replayed on assignment. */
  get handlers(): StdioHandlers {
    return this.current;
  }

  set handlers(value: StdioHandlers) {
    this.current = value;
    const queued = this.pending;
    this.pending = [];
    for (const event of queued) this.dispatch(event);
  }

  private dispatch(event: ChannelEvent): void {
    const handler = this.current[event.kind] as ((arg: never) => void) | undefined;
    if (handler) handler(event.arg as never);
    else if (this.pending.length < MAX_PENDING_EVENTS) this.pending.push(event);
  }

  send(message: JsonObject): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('stdio channel is not open'));
        return;
      }
      this.ws.send(messageFrame(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close(1000);
    });
  }
}

/** HTTP and WebSocket client for one runner (8.3), over TCP (Kubernetes) or a Unix socket (bubblewrap). */
export class HttpRunnerClient implements RunnerClient {
  private token: string | undefined;

  constructor(
    private readonly target: RunnerTarget,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  useToken(token: string): void {
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  private request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const req = http.request(
        {
          ...requestOptions(this.target),
          method,
          path,
          signal: combined,
          headers: this.headers(
            payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(payload)),
                },
          ),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  async health(signal?: AbortSignal): Promise<{ state: 'unbound' | 'bound' | 'running' }> {
    const res = await this.request('GET', '/healthz', undefined, signal);
    if (res.status !== 200) throw new RunnerHttpError(res.status, `healthz answered ${res.status}`);
    return healthResponseSchema.parse(JSON.parse(res.body));
  }

  async bind(token: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request('POST', '/v1/bind', { token }, signal);
    if (res.status !== 204 && res.status !== 200) {
      throw new RunnerHttpError(res.status, `bind answered ${res.status}`);
    }
    this.token = token;
  }

  async *start(request: StartRequestInput, signal?: AbortSignal): AsyncIterable<StartEvent> {
    const payload = JSON.stringify(request);
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          ...requestOptions(this.target),
          method: 'POST',
          path: '/v1/start',
          ...(signal ? { signal } : {}),
          headers: this.headers({
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          }),
        },
        resolve,
      );
      req.on('error', reject);
      req.end(payload);
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new RunnerHttpError(response.statusCode ?? 0, `start answered ${response.statusCode}`);
    }
    response.setEncoding('utf8');
    let pending = '';
    for await (const chunk of response as AsyncIterable<string>) {
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) yield startEventSchema.parse(JSON.parse(line));
        nl = pending.indexOf('\n');
      }
    }
    if (pending.trim()) yield startEventSchema.parse(JSON.parse(pending));
  }

  async stop(signal?: AbortSignal): Promise<void> {
    const res = await this.request('POST', '/v1/stop', {}, signal);
    if (res.status >= 300) throw new RunnerHttpError(res.status, `stop answered ${res.status}`);
  }

  openStdio(signal?: AbortSignal): Promise<StdioChannel> {
    return new Promise((resolve, reject) => {
      const { target } = this;
      // `ws` ignores a `socketPath` option for ws:// URLs (it resolves the host name instead: "ENOTFOUND runner");
      // the IPC form of the URL is the supported way to reach a Unix socket.
      const url =
        target.kind === 'unix'
          ? `ws+unix://${target.socketPath}:/v1/stdio`
          : `ws://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}/v1/stdio`;
      const ws = new WebSocket(url, [STDIO_SUBPROTOCOL], {
        headers: this.headers(),
        handshakeTimeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      let dropped = 0;
      ws.once('upgrade', (res) => {
        const raw = res.headers[DROPPED_HEADER];
        const parsed = Number(Array.isArray(raw) ? raw[0] : (raw ?? 0));
        dropped = Number.isFinite(parsed) ? parsed : 0;
      });
      ws.once('open', () => {
        ws.removeListener('error', reject);
        resolve(new WsStdioChannel(ws, dropped));
      });
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new RunnerHttpError(res.statusCode ?? 0, `stdio answered ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }
}

/** Drives `start` to completion; throws `SandboxStartFailedError` on a `failed` event (8.6). */
export const startAndWait = async (
  runner: RunnerClient,
  request: StartRequestInput,
  context: { installation: string },
  onEvent: (event: StartEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<void> => {
  let last: StartEvent | undefined;
  for await (const event of runner.start(request, signal)) {
    last = event;
    onEvent(event);
    if (event.phase === 'failed') {
      throw new SandboxStartFailedError(event.detail, {
        installation: context.installation,
        phase: 'start',
      });
    }
    if (event.phase === 'ready') return;
  }
  throw new SandboxStartFailedError(`runner stream ended after phase ${last?.phase ?? 'none'}`, {
    installation: context.installation,
    phase: last?.phase ?? 'connecting',
  });
};

/**
 * Runs a `captureLockfile` start (8.7): the runner resolves the dependency tree, answers with the lockfile in its
 * `ready` event and starts nothing. Throws `SandboxStartFailedError` on a `failed` event or a stream without one.
 */
export const captureLockfileVia = async (
  runner: RunnerClient,
  request: StartRequestInput,
  context: { installation: string },
  onEvent: (event: StartEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<{ kind: 'npm-shrinkwrap' | 'uv-requirements'; content: string }> => {
  let last: StartEvent | undefined;
  for await (const event of runner.start({ ...request, captureLockfile: true }, signal)) {
    last = event;
    onEvent(event);
    if (event.phase === 'failed') {
      throw new SandboxStartFailedError(event.detail, {
        installation: context.installation,
        phase: 'installing',
      });
    }
    if (event.phase === 'ready') {
      if (!event.lockfile) {
        throw new SandboxStartFailedError('the runner answered without a lockfile', {
          installation: context.installation,
          phase: 'installing',
        });
      }
      return event.lockfile;
    }
  }
  throw new SandboxStartFailedError(`runner stream ended after phase ${last?.phase ?? 'none'}`, {
    installation: context.installation,
    phase: last?.phase ?? 'installing',
  });
};

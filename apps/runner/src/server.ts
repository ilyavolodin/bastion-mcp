import { chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  bindRequestSchema,
  CLOSE_CODE_REPLACED,
  DROPPED_HEADER,
  decodeFrame,
  exitFrame,
  type JsonObject,
  messageFrame,
  type RunnerStateName,
  STDIO_SUBPROTOCOL,
  type StartEvent,
  type StartPhase,
  type StartRequest,
  startRequestSchema,
  stderrFrame,
} from '@bastion-mcp/sandbox/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import type { ListenTarget } from './args';
import { verifyBearer } from './auth';
import { OutputBuffer } from './buffer';
import { buildInstallEnv, type Installer, redactSecrets } from './install';
import { DEFAULT_KILL_GRACE_MS, ServerProcess } from './process';
import { decideRequest, decideUpgrade, type RunnerState, transition } from './state';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type RunnerOptions = {
  installer: Installer;
  workspaceDir?: string;
  home?: string;
  /** PATH for the installer and the server process; defaults to the runner's own PATH. */
  path?: string;
  killGraceMs?: number;
  /** Environment names copied into installer subprocesses only (for example `UV_PYTHON_INSTALL_DIR`). */
  installPassthrough?: Record<string, string>;
  now?: () => number;
};

export type Runner = {
  readonly state: RunnerState;
  listen(target: ListenTarget): Promise<{ address: string }>;
  close(): Promise<void>;
};

const readBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

export const createRunner = (options: RunnerOptions): Runner => {
  const now = options.now ?? Date.now;
  const workspaceDir = options.workspaceDir ?? '/workspace';
  const home = options.home ?? '/home/sandbox';
  const path = options.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

  let state: RunnerState = 'unbound';
  let token: string | undefined;
  let server: ServerProcess | undefined;
  let starting: AbortController | undefined;
  let socket: WebSocket | undefined;
  let pendingExit: string | undefined;
  const buffer = new OutputBuffer();
  let droppedForNextConnection = 0;

  const apply = (event: 'bind' | 'start' | 'stopped'): boolean => {
    const result = transition(state, event);
    if (result.ok) state = result.state;
    return result.ok;
  };

  const isOpen = (ws: WebSocket | undefined): ws is WebSocket =>
    ws !== undefined && ws.readyState === ws.OPEN;

  const emit = (frame: string): void => {
    if (isOpen(socket)) socket.send(frame);
    else buffer.push(frame);
  };

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(STDIO_SUBPROTOCOL) ? STDIO_SUBPROTOCOL : false),
  });
  wss.on('headers', (headers) => {
    headers.push(`${DROPPED_HEADER}: ${droppedForNextConnection}`);
  });

  const attachSocket = (ws: WebSocket): void => {
    const previous = socket;
    socket = ws;
    if (isOpen(previous)) {
      previous.close(CLOSE_CODE_REPLACED, 'replaced by a newer connection');
    }
    ws.on('message', (data: Buffer) => {
      if (ws !== socket) return;
      const decoded = decodeFrame(data.toString('utf8'), 'toRunner');
      if (!decoded.ok) {
        ws.close(1007, 'invalid frame');
        return;
      }
      if (decoded.frame.t === 'm') server?.write(decoded.frame.d);
    });
    ws.on('close', () => {
      if (socket === ws) socket = undefined;
    });
    ws.on('error', () => {
      // The close event follows; nothing to add.
    });
    const drained = buffer.drain();
    if (drained.dropped > 0) {
      ws.send(stderrFrame(`[runner] dropped ${drained.dropped} messages while disconnected`));
    }
    for (const frame of drained.frames) ws.send(frame);
    if (pendingExit) ws.send(pendingExit);
  };

  const onServerExit = (exit: { code: number | null; signal: string | null }): void => {
    const frame = exitFrame(exit.code, exit.signal);
    if (isOpen(socket)) socket.send(frame);
    else pendingExit = frame;
    server = undefined;
    apply('stopped');
  };

  const handleStart = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    let parsed: StartRequest;
    try {
      parsed = startRequestSchema.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid body' });
      return;
    }
    if (!apply('start')) {
      sendJson(res, 409, { error: 'runner is not ready to start' });
      return;
    }
    pendingExit = undefined;
    droppedForNextConnection = 0;
    buffer.drain();
    const startedAt = now();
    const abort = new AbortController();
    starting = abort;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const event = (
      phase: StartPhase,
      detail: string,
      lockfile?: NonNullable<StartEvent['lockfile']>,
    ): void => {
      const body: StartEvent = {
        phase,
        detail,
        elapsedMs: now() - startedAt,
        ...(lockfile ? { lockfile } : {}),
      };
      if (!res.writableEnded) res.write(`${JSON.stringify(body)}\n`);
    };
    const secrets = [parsed.egress.proxyUrl, ...Object.values(parsed.env)];
    try {
      event('installing', `${parsed.runtime} ${parsed.identifier}@${parsed.version}`);
      const installContext = {
        signal: abort.signal,
        env: buildInstallEnv(parsed, {
          path,
          home,
          ...(options.installPassthrough ? { passthrough: options.installPassthrough } : {}),
        }),
        onDetail: (detail: string) => event('installing', redactSecrets(detail, secrets)),
      };
      if (parsed.captureLockfile) {
        if (!options.installer.capture) throw new Error('this runner cannot capture lockfiles');
        const lockfile = await options.installer.capture(parsed, installContext);
        if (abort.signal.aborted) throw new Error('start aborted');
        event('ready', 'lockfile captured', lockfile);
        return;
      }
      const resolved = await options.installer.install(parsed, installContext);
      if (abort.signal.aborted) throw new Error('start aborted');
      event('starting', resolved.command);
      const proc = new ServerProcess(
        {
          command: resolved.command,
          args: resolved.args,
          env: parsed.env,
          proxyUrl: parsed.egress.proxyUrl,
          cwd: workspaceDir,
          home,
          path,
        },
        {
          onMessage: (message: JsonObject) => emit(messageFrame(message)),
          onStderr: (line) => emit(stderrFrame(line)),
          onExit: onServerExit,
        },
      );
      server = proc;
      await proc.start();
      if (abort.signal.aborted) {
        await proc.stop(options.killGraceMs);
        throw new Error('start aborted');
      }
      event('ready', 'server process spawned');
    } catch (error) {
      server = undefined;
      event(
        'failed',
        redactSecrets(error instanceof Error ? error.message : String(error), secrets),
      );
    } finally {
      starting = undefined;
      // The one place a failed or capture-only start returns to `bound`; a running server's exit goes
      // through `onServerExit`, which clears `server` first.
      if (!server) apply('stopped');
      res.end();
    }
  };

  const handleStop = async (res: http.ServerResponse): Promise<void> => {
    const proc = server;
    await proc?.stop(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    res.writeHead(204).end();
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://runner');
    const decision = decideRequest(
      state,
      { method: req.method ?? 'GET', path: url.pathname },
      verifyBearer(req.headers.authorization, token),
    );
    if (!decision.allow) {
      sendJson(res, decision.status, { error: decision.reason });
      return;
    }
    const fail = (error: unknown): void => {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    };
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /healthz':
        sendJson(res, 200, { state } satisfies { state: RunnerStateName });
        return;
      case 'POST /v1/bind':
        readBody(req)
          .then((body) => {
            const parsed = bindRequestSchema.safeParse(body);
            if (!parsed.success) return sendJson(res, 400, { error: 'invalid bind body' });
            if (!apply('bind')) return sendJson(res, 409, { error: 'runner is already bound' });
            token = parsed.data.token;
            res.writeHead(204).end();
          })
          .catch(fail);
        return;
      case 'POST /v1/start':
        handleStart(req, res).catch(fail);
        return;
      case 'POST /v1/stop':
        handleStop(res).catch(fail);
        return;
      default:
        sendJson(res, 404, { error: 'not found' });
    }
  });

  httpServer.on('upgrade', (req, upgradeSocket: Duplex, head) => {
    const reject = (status: number, reason: string): void => {
      upgradeSocket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      upgradeSocket.destroy();
    };
    const decision = decideUpgrade(
      state,
      req.url ?? '/',
      req.headers,
      verifyBearer(req.headers.authorization, token),
    );
    if (!decision.allow) return reject(decision.status, decision.reason);
    droppedForNextConnection = buffer.dropped;
    wss.handleUpgrade(req, upgradeSocket, head, (ws) => attachSocket(ws));
  });

  return {
    get state() {
      return state;
    },
    async listen(target) {
      if (target.kind === 'unix') {
        await rm(target.path, { force: true });
        await new Promise<void>((resolve, reject) => {
          httpServer.once('error', reject);
          httpServer.listen(target.path, () => resolve());
        });
        await chmod(target.path, 0o600);
        return { address: `unix:${target.path}` };
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(target.port, target.host, () => resolve());
      });
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : target.port;
      return { address: `${target.host}:${port}` };
    },
    async close() {
      starting?.abort();
      await server?.stop(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      for (const client of wss.clients) client.terminate();
      wss.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
};

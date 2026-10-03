import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  CLOSE_CODE_REPLACED,
  captureLockfileVia,
  DROPPED_HEADER,
  exitFrame,
  HttpRunnerClient,
  type JSONRPCMessage,
  type JsonObject,
  messageFrame,
  parseRunnerAddress,
  type RunnerClient,
  RunnerHttpError,
  SandboxStdioTransport,
  STDIO_SUBPROTOCOL,
  type StartEvent,
  type StdioChannel,
  type StdioHandlers,
  startAndWait,
  stderrFrame,
} from '../src';
import { probeBwrap } from '../src/bwrap/probe';

class FakeChannel implements StdioChannel {
  dropped = 0;
  handlers: StdioHandlers = {};
  sent: JsonObject[] = [];
  closed = false;
  async send(m: JsonObject) {
    this.sent.push(m);
  }
  async close() {
    this.closed = true;
  }
}

describe('6.4 SandboxStdioTransport', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'ping' } as JSONRPCMessage;

  it('8.3 send writes message frames and onmessage receives runner messages', async () => {
    const ch = new FakeChannel();
    const t = new SandboxStdioTransport(ch);
    const got: unknown[] = [];
    t.onmessage = (m) => void got.push(m);
    await t.start();
    await t.send(msg);
    expect(ch.sent).toEqual([msg]);
    ch.handlers.onmessage?.({ jsonrpc: '2.0', id: 1, result: {} });
    ch.handlers.onmessage?.({ not: 'jsonrpc' });
    expect(got).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
  it('8.3 stderr lines go to the callback; an x frame surfaces as error then close', async () => {
    const ch = new FakeChannel();
    const lines: string[] = [];
    const t = new SandboxStdioTransport(ch, { onStderr: (l) => lines.push(l) });
    const events: string[] = [];
    t.onerror = (e) => events.push(`error:${e.message}`);
    t.onclose = () => events.push('close');
    await t.start();
    ch.handlers.onstderr?.('warn');
    ch.handlers.onexit?.({ code: 2, signal: null });
    ch.handlers.onclose?.({ code: 1006, reason: '' });
    expect(lines).toEqual(['warn']);
    expect(t.exit).toEqual({ code: 2, signal: null });
    expect(events).toEqual(['error:sandboxed server exited (code 2, signal null)', 'close']);
    await expect(t.send(msg)).rejects.toThrow(/closed/);
  });
  it('21.2 a close with 4001 records the replacement; start twice and send before close are guarded', async () => {
    const ch = new FakeChannel();
    const t = new SandboxStdioTransport(ch);
    await t.start();
    await expect(t.start()).rejects.toThrow(/already started/);
    const errors: Error[] = [];
    t.onerror = (e) => errors.push(e);
    ch.handlers.onerror?.(new Error('x'));
    ch.handlers.onclose?.({ code: CLOSE_CODE_REPLACED, reason: 'replaced' });
    expect(t.closeCode).toBe(4001);
    expect(errors).toHaveLength(1);
    await t.close();
    expect(ch.closed).toBe(false);
  });
  it('6.4 close() closes the channel once', async () => {
    const ch = new FakeChannel();
    const t = new SandboxStdioTransport(ch);
    await t.start();
    await t.close();
    await t.close();
    expect(ch.closed).toBe(true);
  });
});

describe('8.3 RunnerClient against a scripted runner', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let requests: { method?: string; url?: string; auth?: string; body: string }[];
  let client: HttpRunnerClient;
  let startBody: string;
  const dropped = 3;
  let sockets: import('ws').WebSocket[];

  beforeEach(async () => {
    requests = [];
    sockets = [];
    startBody = '';
    wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (p) => (p.has(STDIO_SUBPROTOCOL) ? STDIO_SUBPROTOCOL : false),
    });
    wss.on('headers', (h) => void h.push(`${DROPPED_HEADER}: ${dropped}`));
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        requests.push({
          ...(req.method ? { method: req.method } : {}),
          ...(req.url ? { url: req.url } : {}),
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          body,
        });
        if (req.url === '/healthz') return void res.end('{"state":"bound"}');
        if (req.url === '/v1/bind') return void res.writeHead(204).end();
        if (req.url === '/v1/stop')
          return void res.writeHead(req.headers.authorization ? 204 : 401).end();
        if (req.url === '/v1/start') {
          if (startBody === 'fail409') return void res.writeHead(409).end();
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          return void res.end(startBody);
        }
        res.writeHead(404).end();
      });
    });
    server.on('upgrade', (req, socket, head) => {
      if (!req.headers.authorization) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return void socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.push(ws);
        ws.send(stderrFrame('early'));
        ws.on('message', (d: Buffer) => {
          const m = JSON.parse(d.toString()) as { d: JsonObject };
          ws.send(messageFrame({ jsonrpc: '2.0', id: m.d.id as number, result: { ok: true } }));
          ws.send('garbage');
          ws.send(exitFrame(1, null));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    client = new HttpRunnerClient(parseRunnerAddress(`127.0.0.1:${port}`), { timeoutMs: 3000 });
  });
  afterEach(async () => {
    for (const s of sockets) s.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('8.2 parses runner addresses (host:port, [v6]:port, unix:)', () => {
    expect(parseRunnerAddress('10.0.0.1:8080')).toEqual({
      kind: 'tcp',
      host: '10.0.0.1',
      port: 8080,
    });
    expect(parseRunnerAddress('[fd00::1]:8080')).toEqual({
      kind: 'tcp',
      host: 'fd00::1',
      port: 8080,
    });
    expect(parseRunnerAddress('unix:/run/x.sock')).toEqual({
      kind: 'unix',
      socketPath: '/run/x.sock',
    });
    expect(() => parseRunnerAddress('nope')).toThrow(TypeError);
    expect(() => parseRunnerAddress('h:99999')).toThrow(TypeError);
  });
  it('8.3 health, bind (token kept) and stop with the bearer token', async () => {
    expect(await client.health()).toEqual({ state: 'bound' });
    await client.bind('t'.repeat(32));
    await client.stop();
    expect(requests.find((r) => r.url === '/v1/bind')?.body).toBe(
      JSON.stringify({ token: 't'.repeat(32) }),
    );
    expect(requests.find((r) => r.url === '/v1/stop')?.auth).toBe(`Bearer ${'t'.repeat(32)}`);
    const anon = new HttpRunnerClient(parseRunnerAddress(`127.0.0.1:${port}`));
    await expect(anon.stop()).rejects.toBeInstanceOf(RunnerHttpError);
    await expect(anon.health()).resolves.toBeDefined();
  });
  it('8.3 start streams NDJSON events across chunk boundaries and startAndWait resolves on ready', async () => {
    startBody = `{"phase":"installing","detail":"npm ci","elapsedMs":1}\n{"phase":"ready","detail":"ok","elapsedMs":9}`;
    const seen: StartEvent[] = [];
    await startAndWait(
      client,
      { runtime: 'npm', identifier: 'x', version: '1.0.0', egress: { proxyUrl: 'http://p:1' } },
      { installation: 'i' },
      (e) => seen.push(e),
    );
    expect(seen.map((e) => e.phase)).toEqual(['installing', 'ready']);
  });
  it('8.6 startAndWait maps failed and truncated streams to SANDBOX_START_FAILED', async () => {
    const req = {
      runtime: 'npm' as const,
      identifier: 'x',
      version: '1.0.0',
      egress: { proxyUrl: 'http://p:1' },
    };
    startBody = '{"phase":"failed","detail":"E404","elapsedMs":3}\n';
    await expect(startAndWait(client, req, { installation: 'i' })).rejects.toMatchObject({
      code: 'SANDBOX_START_FAILED',
      message: 'E404',
    });
    startBody = '{"phase":"installing","detail":"x","elapsedMs":3}\n';
    await expect(startAndWait(client, req, { installation: 'i' })).rejects.toThrow(
      /ended after phase installing/,
    );
    startBody = '';
    await expect(startAndWait(client, req, { installation: 'i' })).rejects.toThrow(/none/);
    startBody = 'fail409';
    await expect(startAndWait(client, req, { installation: 'i' })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('8.3 the stdio WebSocket sends m frames, queues early events until handlers are set, reports dropped and decodes x', async () => {
    client.useToken('tok-tok-tok-tok-tok');
    const ch = await client.openStdio();
    expect(ch.dropped).toBe(3);
    await new Promise((r) => setTimeout(r, 50));
    const stderr: string[] = [];
    ch.handlers = { onstderr: (l) => stderr.push(l) };
    expect(stderr).toEqual(['early']);
    const events: string[] = [];
    ch.handlers = {
      onmessage: (m) => events.push(`m:${JSON.stringify(m)}`),
      onexit: (x) => events.push(`x:${x.code}`),
      onerror: (e) => events.push(`e:${e.message}`),
      onclose: (c) => events.push(`c:${c.code}`),
    };
    await ch.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([
      'm:{"jsonrpc":"2.0","id":5,"result":{"ok":true}}',
      'e:runner sent an invalid frame: frame is not JSON',
      'x:1',
    ]);
    await ch.close();
    expect(events.at(-1)).toMatch(/^c:(1000|1005)$/);
    await expect(ch.send({ jsonrpc: '2.0', id: 6 })).rejects.toThrow(/not open/);
    await ch.close();
  });
  it('21.2 opening stdio without a token is refused with the HTTP status', async () => {
    await expect(client.openStdio()).rejects.toMatchObject({ status: 401 });
  });
  it('8.3 reaches a Unix-socket runner address shape', async () => {
    const c = new HttpRunnerClient(
      { kind: 'unix', socketPath: '/nonexistent/runner.sock' },
      { timeoutMs: 500 },
    );
    await expect(c.health()).rejects.toBeDefined();
    await expect(c.openStdio()).rejects.toBeDefined();
  });
});

describe.skipIf(process.platform === 'win32')('8.3 stdio over a Unix socket', () => {
  it('8.3 opens the WebSocket on the socket path instead of resolving a host called "runner"', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bastion-ws-'));
    const socketPath = join(dir, 'runner.sock');
    const server = http.createServer();
    const wss = new WebSocketServer({ server, handleProtocols: () => STDIO_SUBPROTOCOL });
    wss.on('connection', (ws) => ws.send(stderrFrame('hello over a socket')));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const unix = new HttpRunnerClient({ kind: 'unix', socketPath });
      const channel = await unix.openStdio();
      const lines: string[] = [];
      channel.handlers = { onstderr: (l) => lines.push(l) };
      await new Promise((r) => setTimeout(r, 100));
      expect(lines).toEqual(['hello over a socket']);
      await channel.close();
    } finally {
      wss.close();
      server.close();
    }
  });
});

describe('8.5 probe against the real system', () => {
  it('8.5 reports unavailable with the error text when the bwrap binary does not exist', async () => {
    const result = await probeBwrap(undefined, 'definitely-not-bwrap-binary');
    expect(result.status).toBe('unavailable');
  });
});

describe('8.7 captureLockfileVia', () => {
  const runnerOf = (events: StartEvent[]): RunnerClient =>
    ({
      start: async function* () {
        for (const event of events) yield event;
      },
    }) as unknown as RunnerClient;
  const ev = (phase: StartEvent['phase'], extra: Partial<StartEvent> = {}): StartEvent => ({
    phase,
    detail: `${phase} detail`,
    elapsedMs: 1,
    ...extra,
  });
  const request = {
    runtime: 'npm',
    identifier: 'x',
    version: '1.0.0',
    egress: { proxyUrl: 'http://p:1' },
  } as const;
  const ctx = { installation: 'inst-1' };

  it('8.7 returns the lockfile of the ready event and reports every event', async () => {
    const lockfile = { kind: 'npm-shrinkwrap', content: '{}' } as const;
    const seen: string[] = [];
    const result = await captureLockfileVia(
      runnerOf([ev('installing'), ev('ready', { lockfile })]),
      request,
      ctx,
      (e) => seen.push(e.phase),
    );
    expect(result).toEqual(lockfile);
    expect(seen).toEqual(['installing', 'ready']);
  });

  it('8.7 a failed event throws SandboxStartFailedError with its detail', async () => {
    await expect(
      captureLockfileVia(runnerOf([ev('failed', { detail: 'npm exploded' })]), request, ctx),
    ).rejects.toMatchObject({
      code: 'SANDBOX_START_FAILED',
      message: expect.stringContaining('npm exploded'),
    });
  });

  it('8.7 a ready event without a lockfile is an error', async () => {
    await expect(captureLockfileVia(runnerOf([ev('ready')]), request, ctx)).rejects.toThrow(
      /without a lockfile/,
    );
  });

  it('8.7 a stream that ends early names the last phase', async () => {
    await expect(captureLockfileVia(runnerOf([ev('installing')]), request, ctx)).rejects.toThrow(
      /ended after phase installing/,
    );
    await expect(captureLockfileVia(runnerOf([]), request, ctx)).rejects.toThrow(/phase none/);
  });

  it('8.7 sends captureLockfile: true', async () => {
    let sent: unknown;
    const runner = {
      start: async function* (req: unknown) {
        sent = req;
        yield ev('ready', { lockfile: { kind: 'uv-requirements', content: 'a==1' } });
      },
    } as unknown as RunnerClient;
    await captureLockfileVia(runner, request, ctx);
    expect(sent).toMatchObject({ captureLockfile: true });
  });
});

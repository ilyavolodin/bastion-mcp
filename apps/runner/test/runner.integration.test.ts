import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HttpRunnerClient,
  parseRunnerAddress,
  SandboxStdioTransport,
  type StartEvent,
  type StdioChannel,
  startAndWait,
} from '@bastion-mcp/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEgressForwarder } from '../src/egress-forward';
import type { Installer } from '../src/install';
import { createRunner, type Runner } from '../src/server';

const script = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));
const TOKEN = 'a-very-long-runner-token-0123456789';
const START = {
  runtime: 'npm' as const,
  identifier: 'fake-server',
  version: '1.0.0',
  env: { FAKE: 'secret-env-value' },
  egress: { proxyUrl: 'http://127.0.0.1:3128' },
};

/** Installation is skipped: the "installed" command is the local echo script. */
const localInstaller: Installer = {
  install: async (_req, ctx) => {
    ctx.onDetail('using local script');
    return { command: process.execPath, args: [script] };
  },
};

const collect = async (iterable: AsyncIterable<StartEvent>): Promise<StartEvent[]> => {
  const out: StartEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
};

const nextMessage = (channel: StdioChannel): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    channel.handlers = { ...channel.handlers, onmessage: (m) => resolve(m) };
  });

describe('8.3 runner (real HTTP + WebSocket, fake stdio server)', () => {
  let runner: Runner;
  let client: HttpRunnerClient;
  let workspace: string;
  let address: string;

  const boot = async (installer: Installer = localInstaller) => {
    workspace = await mkdtemp(path.join(tmpdir(), 'runner-ws-'));
    runner = createRunner({
      installer,
      workspaceDir: workspace,
      home: workspace,
      killGraceMs: 300,
    });
    ({ address } = await runner.listen({ kind: 'tcp', host: '127.0.0.1', port: 0 }));
    client = new HttpRunnerClient(parseRunnerAddress(address), { timeoutMs: 5000 });
  };

  beforeEach(async () => {
    await boot();
  });
  afterEach(async () => {
    await runner.close();
  });

  it('8.3 /healthz reports the state in any state', async () => {
    expect(await client.health()).toEqual({ state: 'unbound' });
    await client.bind(TOKEN);
    expect(await client.health()).toEqual({ state: 'bound' });
  });

  it('8.3 bind is accepted exactly once; afterwards the token is required', async () => {
    await client.bind(TOKEN);
    // unauthenticated: the token is required as soon as the runner is bound
    await expect(
      new HttpRunnerClient(parseRunnerAddress(address)).bind('another-long-token-value'),
    ).rejects.toMatchObject({ status: 401 });
    // authenticated but already bound
    await expect(client.bind(TOKEN)).rejects.toMatchObject({ status: 409 });
    const anonymous = new HttpRunnerClient(parseRunnerAddress(address));
    await expect(anonymous.stop()).rejects.toMatchObject({ status: 401 });
    anonymous.useToken('wrong-token-wrong-token');
    await expect(anonymous.stop()).rejects.toMatchObject({ status: 401 });
    expect(runner.state).toBe('bound');
  });

  it('8.3 rejects /v1/start before bind and a malformed start body', async () => {
    await expect(collect(client.start(START))).rejects.toMatchObject({ status: 409 });
    await client.bind(TOKEN);
    await expect(collect(client.start({ runtime: 'npm' } as never))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('8.3 start streams installing, starting and ready as NDJSON', async () => {
    await client.bind(TOKEN);
    const events = await collect(client.start(START));
    expect(events.map((e) => e.phase)).toEqual(['installing', 'installing', 'starting', 'ready']);
    expect(events.every((e) => typeof e.elapsedMs === 'number')).toBe(true);
    expect(await client.health()).toEqual({ state: 'running' });
  });

  it('8.3 start reports failed (with redacted detail) when installation throws', async () => {
    await runner.close();
    await boot({
      install: async () => {
        throw new Error('npm ci failed for http://127.0.0.1:3128 and secret-env-value');
      },
    });
    await client.bind(TOKEN);
    const events = await collect(client.start(START));
    expect(events.at(-1)?.phase).toBe('failed');
    expect(events.at(-1)?.detail).toContain('[redacted]');
    expect(events.at(-1)?.detail).not.toContain('secret-env-value');
    expect(await client.health()).toEqual({ state: 'bound' });
    await expect(startAndWait(client, START, { installation: 'i1' })).rejects.toThrow(
      /npm ci failed/,
    );
  });

  it('8.3 start fails when the resolved command cannot spawn', async () => {
    await runner.close();
    await boot({ install: async () => ({ command: '/definitely/not/here', args: [] }) });
    await client.bind(TOKEN);
    const events = await collect(client.start(START));
    expect(events.at(-1)?.phase).toBe('failed');
  });

  it('8.3 the stdio WebSocket carries JSON-RPC both ways (SDK-compatible transport)', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const channel = await client.openStdio();
    const transport = new SandboxStdioTransport(channel);
    const received = new Promise<unknown>((resolve) => {
      transport.onmessage = (m) => resolve(m);
    });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { a: 1 } });
    expect(await received).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { echo: { a: 1 }, method: 'ping' },
    });
    await transport.close();
  });

  it('8.3 spawns with a clean env, cwd /workspace and non-JSON stdout becomes stderr', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const channel = await client.openStdio();
    const stderr: string[] = [];
    const first = nextMessage(channel);
    channel.handlers = { ...channel.handlers, onstderr: (l) => stderr.push(l) };
    await channel.send({ jsonrpc: '2.0', id: 1, method: 'env' });
    const reply = (await first) as { result: { env: Record<string, string>; cwd: string } };
    const expected = ['FAKE', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'PATH'];
    // Windows adds SYSTEMROOT and friends to every child; the Linux suite asserts exact equality.
    const keys = Object.keys(reply.result.env).filter(
      (k) => process.platform !== 'win32' || expected.includes(k),
    );
    expect(keys.sort()).toEqual([...expected].sort());
    expect(reply.result.env.NO_PROXY).toBe('');
    expect(reply.result.env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(reply.result.cwd.toLowerCase()).toContain(path.basename(workspace).toLowerCase());
    const second = nextMessage(channel);
    await channel.send({ jsonrpc: '2.0', id: 2, method: 'noise' });
    await second;
    await channel.send({ jsonrpc: '2.0', id: 3, method: 'warn' });
    await new Promise((r) => setTimeout(r, 200));
    expect(stderr).toContain('this is not json');
    expect(stderr).toContain('warning from server');
    await channel.close();
  });

  it('8.3 a second connection replaces the first, which is closed with 4001', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const first = await client.openStdio();
    const closed = new Promise<{ code: number }>((resolve) => {
      first.handlers = { onclose: resolve };
    });
    const second = await client.openStdio();
    expect((await closed).code).toBe(4001);
    const reply = nextMessage(second);
    await second.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(((await reply) as { id: number }).id).toBe(9);
    await second.close();
  });

  it('21.2 a stdio connection without the valid token or subprotocol is refused', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const bad = new HttpRunnerClient(parseRunnerAddress(address));
    bad.useToken('wrong-token-wrong-token');
    await expect(bad.openStdio()).rejects.toMatchObject({ status: 401 });
    const { WebSocket } = await import('ws');
    const noProtocol = new WebSocket(`ws://${address}/v1/stdio`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise<void>((resolve) => {
      noProtocol.on('unexpected-response', (_q, res) => {
        expect(res.statusCode).toBe(400);
        res.resume();
        resolve();
      });
      noProtocol.on('error', () => {});
    });
  });

  it('8.3 /v1/stdio is refused before start (state bound, not running)', async () => {
    await client.bind(TOKEN);
    await expect(client.openStdio()).rejects.toMatchObject({ status: 409 });
  });

  it('8.3 buffers server output while disconnected and reports the dropped counter on reconnect', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const first = await client.openStdio();
    await first.send({ jsonrpc: '2.0', id: 1, method: 'flood', params: { count: 1500 } });
    await first.close(); // flood output continues into the buffer after this point (race-tolerant)
    await new Promise((r) => setTimeout(r, 500));
    const second = await client.openStdio();
    const seen: unknown[] = [];
    const stderr: string[] = [];
    second.handlers = { onmessage: (m) => seen.push(m), onstderr: (l) => stderr.push(l) };
    await new Promise((r) => setTimeout(r, 400));
    expect(second.dropped + seen.length).toBeGreaterThan(0);
    // When the flood outlives the disconnect window (a busy machine) it streams live and nothing is dropped;
    // the 1,000-message cap is asserted whenever output was actually buffered. The buffer's own cap and
    // drop-oldest behavior are covered deterministically by the pure unit tests.
    if (second.dropped > 0) expect(seen.length).toBeLessThanOrEqual(1000);
    if (second.dropped > 0) {
      expect(stderr.some((l) => l.includes(`dropped ${second.dropped}`))).toBe(true);
    }
    await second.close();
  });

  it('8.6 an exit of the server is reported as an x frame and returns the runner to bound', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const channel = await client.openStdio();
    const transport = new SandboxStdioTransport(channel);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    transport.onerror = () => {};
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'exit' });
    await closed;
    expect(transport.exit).toEqual({ code: 3, signal: null });
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'x' })).rejects.toThrow(/closed/);
    expect(await client.health()).toEqual({ state: 'bound' });
    // a restart works after an exit
    await startAndWait(client, START, { installation: 'i1' });
    expect(await client.health()).toEqual({ state: 'running' });
  });

  it('8.3 an exit while disconnected is delivered when the worker reconnects', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    const first = await client.openStdio();
    await first.send({ jsonrpc: '2.0', id: 1, method: 'exit' });
    await first.close();
    // Wait for the exit to land (it can lag when the machine is busy), not a fixed sleep.
    await vi.waitFor(async () => expect(await client.health()).toEqual({ state: 'bound' }), {
      timeout: 10_000,
    });
    // state is bound after the exit, so stdio is refused: the manager restarts instead
    await expect(client.openStdio()).rejects.toMatchObject({ status: 409 });
  });

  it('8.3 stop sends SIGTERM and returns to bound; a stubborn server is killed after the grace period', async () => {
    await client.bind(TOKEN);
    await startAndWait(client, START, { installation: 'i1' });
    await client.stop();
    expect(await client.health()).toEqual({ state: 'bound' });

    await runner.close();
    await boot({
      install: async () => ({ command: process.execPath, args: [script] }),
    });
    await client.bind(TOKEN);
    await startAndWait(client, { ...START, env: { IGNORE_SIGTERM: '1' } }, { installation: 'i1' });
    // "started" only means spawned: a SIGTERM that lands before node has run the script's handler kills it at once.
    // The fixture registers the handler before it reads stdin, so one answered request proves it is in place.
    const channel = await client.openStdio();
    const reply = nextMessage(channel);
    await channel.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await reply;
    const started = Date.now();
    await client.stop();
    // Windows has no catchable SIGTERM; elsewhere the server ignores it and is killed after killGraceMs.
    if (process.platform !== 'win32') expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await client.health()).toEqual({ state: 'bound' });
  });

  it('8.3 unknown routes answer 404 once bound and authenticated', async () => {
    await client.bind(TOKEN);
    const res = await fetch(`http://${address}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('8.3 runner on a Unix socket', () => {
  it('8.5 listens on --listen unix:<path> and the client reaches it', async () => {
    if (process.platform === 'win32') return; // AF_UNIX paths differ; covered in the Linux suite
    const dir = await mkdtemp(path.join(tmpdir(), 'runner-sock-'));
    const sock = path.join(dir, 'runner.sock');
    const runner = createRunner({ installer: localInstaller });
    const { address } = await runner.listen({ kind: 'unix', path: sock });
    const client = new HttpRunnerClient(parseRunnerAddress(address));
    expect(await client.health()).toEqual({ state: 'unbound' });
    await runner.close();
  });
});

describe('8.5 egress forwarder', () => {
  it('8.5 relays bytes from 127.0.0.1:<port> to the egress socket', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'egress-sock-'));
    const sock =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\bastion-test-${process.pid}`
        : path.join(dir, 'e.sock');
    const upstream = net.createServer((c) => c.on('data', (d) => c.write(`echo:${d.toString()}`)));
    await new Promise<void>((resolve) => upstream.listen(sock, resolve));
    const fwd = await startEgressForwarder({ socketPath: sock, port: 0 });
    const reply = await new Promise<string>((resolve) => {
      const c = net.connect(fwd.port, '127.0.0.1', () => c.write('hello'));
      c.on('data', (d) => {
        resolve(d.toString());
        c.destroy();
      });
    });
    expect(reply).toBe('echo:hello');
    await fwd.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});

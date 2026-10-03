import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressForwarder } from '../src/egress-forward';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const socketPath = async (name: string): Promise<string> =>
  process.platform === 'win32'
    ? String.raw`\\.\pipe\bastion-egress-${name}-${process.pid}`
    : path.join(await mkdtemp(path.join(tmpdir(), 'egress-')), `${name}.sock`);

const closed = (socket: net.Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())));

describe('8.5 egress forwarder failure modes', () => {
  it('8.5 closes the client when the egress socket cannot be reached', async () => {
    const forwarder = await startEgressForwarder({
      socketPath: await socketPath('missing'),
      port: 0,
    });
    cleanups.push(() => forwarder.close());
    const client = net.connect(forwarder.port, '127.0.0.1');
    client.on('error', () => undefined);
    await closed(client);
    expect(client.destroyed).toBe(true);
  });

  it('8.5 close() destroys active tunnels instead of waiting for them', async () => {
    const sock = await socketPath('active');
    const upstream = net.createServer((c) => c.on('data', (d) => c.write(d)));
    await new Promise<void>((resolve) => upstream.listen(sock, resolve));
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const forwarder = await startEgressForwarder({ socketPath: sock, port: 0 });
    const client = net.connect(forwarder.port, '127.0.0.1');
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => {
      client.once('data', () => resolve());
      client.write('ping');
    });
    await forwarder.close(); // would hang if the open tunnel kept the server alive
    await closed(client);
    expect(client.destroyed).toBe(true);
  });

  it('8.5 rejects when the listen port is already taken', async () => {
    const first = await startEgressForwarder({ socketPath: await socketPath('a'), port: 0 });
    cleanups.push(() => first.close());
    await expect(
      startEgressForwarder({ socketPath: await socketPath('b'), port: first.port }),
    ).rejects.toThrow();
  });
});

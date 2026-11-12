import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEgressProxy, type EgressProxy } from '../src/egress';
import { sha256Hex } from '../src/supply-chain';

const TOKEN = 'egress-token-1';
const AUTH = `Basic ${Buffer.from(`inst-1:${TOKEN}`).toString('base64')}`;

const exchange = (port: number, request: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (d) => {
      data += d.toString('latin1');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', () => socket.destroy());
  });

const statusLine = (raw: string) => raw.split('\r\n')[0];

const start = async (allow: string[], resolver: (host: string) => Promise<string[]>) => {
  const proxy = createEgressProxy({
    policies: {
      get: async (id) =>
        id === 'inst-1' ? { tokenSha256: sha256Hex(TOKEN), allow, phase: 'running' } : null,
    },
    audit: { record: () => {} },
    resolver,
    connect: () => net.connect({ host: '127.0.0.1', port: 1 }),
  });
  const { port } = await proxy.listenTcp(0, '127.0.0.1');
  return { proxy, port };
};

const viaConnect = (port: number, target: string) =>
  exchange(port, `CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
const viaHttp = (port: number, url: string) =>
  exchange(
    port,
    `GET ${url} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${AUTH}\r\nConnection: close\r\n\r\n`,
  );

describe('8.8 the allowlist is checked before any DNS lookup', () => {
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    vi.restoreAllMocks();
  });

  it('a host that is not allowlisted and does not resolve is refused 403 without a lookup (CONNECT and HTTP)', async () => {
    const resolver = vi.fn(async (_host: string): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    });
    const started = await start(['ok.test'], resolver);
    proxy = started.proxy;
    expect(statusLine(await viaConnect(started.port, 'nope.test:443'))).toMatch(/^HTTP\/1\.1 403 /);
    expect(statusLine(await viaHttp(started.port, 'http://nope.test/'))).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('an allowlisted host that does not resolve still answers 502 after one lookup', async () => {
    const resolver = vi.fn(async (_host: string): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    });
    const started = await start(['gone.test'], resolver);
    proxy = started.proxy;
    expect(statusLine(await viaConnect(started.port, 'gone.test:443'))).toMatch(/^HTTP\/1\.1 502 /);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('with a CIDR rule in the policy a name that is not allowlisted is still resolved, because the address may be allowed', async () => {
    const resolver = vi.fn(async (_host: string): Promise<string[]> => ['93.184.216.34']);
    const started = await start(['93.184.216.0/24'], resolver);
    proxy = started.proxy;
    await viaConnect(started.port, 'cidr.test:443');
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

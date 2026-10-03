import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, readBody, readJsonBody, startHttp } from '../src';
import { startFakeRegistry } from '../src/fake-upstreams';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('testkit http helpers', () => {
  it('freePort returns a port that can be bound right away', async () => {
    const port = await freePort();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(port).toBeGreaterThan(0);
  });

  it('startHttp serves a handler and reads raw and JSON bodies', async () => {
    const http = await startHttp(async (req, res) => {
      const raw = (await readBody(req)).toString('utf8');
      res.end(JSON.stringify({ raw }));
    });
    closers.push(http.close);
    const reply = await fetch(`${http.url}/x`, { method: 'POST', body: '{"a":1}' });
    expect(await reply.json()).toEqual({ raw: '{"a":1}' });
  });

  it('readJsonBody parses JSON and maps empty or invalid bodies to undefined', async () => {
    const seen: unknown[] = [];
    const http = await startHttp(async (req, res) => {
      seen.push(await readJsonBody(req));
      res.end();
    });
    closers.push(http.close);
    for (const body of ['{"a":1}', '', '{nope']) {
      await fetch(http.url, body ? { method: 'POST', body } : { method: 'POST' });
    }
    expect(seen).toEqual([{ a: 1 }, undefined, undefined]);
  });

  it('startHttp answers 500 when the handler throws', async () => {
    const http = await startHttp(() => {
      throw new Error('boom');
    });
    closers.push(http.close);
    expect((await fetch(http.url)).status).toBe(500);
  });

  it('the fake registry pages entries and injects failures', async () => {
    const registry = await startFakeRegistry();
    closers.push(registry.close);
    registry.setEntries([
      { server: { name: 'a', version: '1' } },
      { server: { name: 'b', version: '1' } },
    ]);
    const page = (await (await fetch(`${registry.baseUrl}/v0.1/servers?limit=1`)).json()) as {
      metadata: { nextCursor?: string };
    };
    expect(page.metadata.nextCursor).toBe('1');
    registry.failNext(503);
    expect((await fetch(`${registry.baseUrl}/v0.1/servers`)).status).toBe(503);
    expect(registry.requests).toHaveLength(2);
  });
});

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, DB_CONNECT_TIMEOUT_MS, pgConnectionOptions } from '../src/client';

/** A database that accepts the TCP connection and then never answers: the shape of the production wedge. */
const silentServer = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgres://u:p@127.0.0.1:${port}/db`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
};

describe('database connect timeout', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
  });

  it('applies a connect timeout and keepalive to every pg client by default', () => {
    expect(pgConnectionOptions('postgres://x')).toMatchObject({
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      keepAlive: true,
    });
    expect(DB_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('fails a query instead of hanging, and frees the pool slot, when the server never answers', async () => {
    const server = await silentServer();
    cleanup.push(server.close);
    const db = createDb({ url: server.url, poolMax: 2, connectTimeoutMs: 300 });
    cleanup.push(db.close);
    // More queries than slots: without a timeout the first two hang forever and the rest queue behind them.
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => db.prisma.$queryRaw`SELECT 1`),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});

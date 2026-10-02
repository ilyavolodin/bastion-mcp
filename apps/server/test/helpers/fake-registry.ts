import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeRegistry = {
  baseUrl: string;
  /** Entries (list elements, `{ server, status? }`) served by `/v0.1/servers`, paged by `limit`. */
  setEntries(entries: unknown[]): void;
  requests: string[];
  close(): Promise<void>;
};

/** A registry implementing the list endpoint of the MCP Registry REST API v0.1 (11.6). */
export const startFakeRegistry = async (): Promise<FakeRegistry> => {
  let entries: unknown[] = [];
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v0.1/servers') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? '30');
    const offset = Number(url.searchParams.get('cursor') ?? '0');
    const slice = entries.slice(offset, offset + limit);
    const next = offset + limit < entries.length ? String(offset + limit) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        servers: slice,
        metadata: { count: slice.length, ...(next ? { nextCursor: next } : {}) },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setEntries: (e) => {
      entries = e;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

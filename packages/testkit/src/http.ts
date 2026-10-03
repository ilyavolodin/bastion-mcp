import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The whole request body. */
export const readBody = async (req: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
};

/** The request body parsed as JSON; empty or invalid bodies give `undefined`. */
export const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
};

export type RunningHttp = {
  server: http.Server;
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  /** Drops open connections, then closes the listener. */
  close: () => Promise<void>;
};

/**
 * Starts `handler` on an ephemeral loopback port. A handler that throws or rejects answers 500 (if nothing was
 * sent yet) instead of crashing the test process.
 */
export const startHttp = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  options: { host?: string } = {},
): Promise<RunningHttp> => {
  const host = options.host ?? '127.0.0.1';
  const server = http.createServer((req, res) => {
    const fail = (): void => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    };
    try {
      Promise.resolve(handler(req, res)).catch(fail);
    } catch {
      fail();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

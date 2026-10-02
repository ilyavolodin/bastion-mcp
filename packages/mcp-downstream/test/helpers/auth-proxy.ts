import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The conformance CLI cannot send an `Authorization` header, so it talks to this proxy, which adds the bearer token and
 * forwards everything else (including SSE streams and the `Host` header) to the gateway unchanged.
 */
export const startAuthProxy = async (
  target: string,
  token: string,
): Promise<{ url: string; port: number; close: () => Promise<void> }> => {
  const upstream = new URL(target);
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, authorization: `Bearer ${token}` };
    const proxied = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        res.on('close', () => upstreamRes.destroy());
      },
    );
    proxied.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxied);
    res.on('close', () => proxied.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

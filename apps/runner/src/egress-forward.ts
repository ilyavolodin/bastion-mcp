import net from 'node:net';

export const DEFAULT_EGRESS_HOST = '127.0.0.1';
export const DEFAULT_EGRESS_PORT = 3128;

/**
 * Bubblewrap mode (8.5): inside the jail only loopback exists, so the runner listens on 127.0.0.1:3128 and
 * relays raw bytes (CONNECT tunnels and absolute-form HTTP alike) to the per-instance Unix socket that the
 * worker's egress proxy serves. The socket identifies the sandbox, so no credentials are involved.
 */
export const startEgressForwarder = (options: {
  socketPath: string;
  host?: string;
  port?: number;
}): Promise<{ port: number; close(): Promise<void> }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect(options.socketPath);
      sockets.add(client);
      sockets.add(upstream);
      const cleanup = (): void => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', cleanup);
      upstream.on('error', cleanup);
      client.on('close', cleanup);
      upstream.on('close', cleanup);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_EGRESS_PORT, options.host ?? DEFAULT_EGRESS_HOST, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : (options.port ?? DEFAULT_EGRESS_PORT),
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });

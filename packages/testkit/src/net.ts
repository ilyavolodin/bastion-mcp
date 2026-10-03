import net from 'node:net';

/** A TCP port that was free a moment ago. Prefer listening on port 0 where the caller can. */
export const freePort = (host = '127.0.0.1'): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

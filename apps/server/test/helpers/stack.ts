/**
 * Boots the real server in-process against the shared containers: `startServer` with `BASTION_ROLE` all, worker or
 * ui, ephemeral ports, plain HTTP behind the `proxyFetch` illusion of `https://bastion.test`.
 */
import { createServer } from 'node:net';
import type { SandboxDriver } from '@bastion-mcp/sandbox';
import type { ServerOptions } from '../../src/config';
import { type RunningServer, startServer } from '../../src/server';
import type { TestEnv } from './env';
import { type FetchLike, PUBLIC_URL, proxyFetch } from './proxy-fetch';

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

export type StackOptions = {
  env: TestEnv;
  role?: 'all' | 'worker' | 'ui';
  workerId?: string;
  /** Extra environment variables (`BASTION_*`). */
  vars?: Record<string, string>;
  sandboxDriver?: SandboxDriver;
  scheduler?: boolean;
  options?: Partial<ServerOptions>;
};

export type Stack = {
  server: RunningServer;
  port: number;
  /** `https://bastion.test` */
  publicUrl: string;
  fetch: FetchLike;
  url: (path: string) => string;
  stop: () => Promise<void>;
};

export const bootStack = async (opts: StackOptions): Promise<Stack> => {
  const [httpPort, internalPort, egressPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const env = opts.env.env({
    BASTION_ROLE: opts.role ?? 'all',
    BASTION_HTTP_PORT: String(httpPort),
    BASTION_INTERNAL_PORT: String(internalPort),
    BASTION_EGRESS_PORT: String(egressPort),
    BASTION_PUBLIC_URL: PUBLIC_URL,
    BASTION_SANDBOX_DRIVER: 'bubblewrap',
    BASTION_INSECURE_UPSTREAM_HOSTS: '127.0.0.1,localhost',
    BASTION_PRIVATE_UPSTREAM_CIDRS: '127.0.0.0/8',
    ...(opts.vars ?? {}),
  });
  const server = await startServer(env, {
    listenHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    allowInsecureHttp: true,
    scheduler: opts.scheduler ?? false,
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
    ...(opts.sandboxDriver ? { sandboxDriver: opts.sandboxDriver } : {}),
    ...opts.options,
  });
  return {
    server,
    port: server.port,
    publicUrl: PUBLIC_URL,
    fetch: proxyFetch(server.port),
    url: (path) => `${PUBLIC_URL}${path}`,
    stop: () => server.stop(),
  };
};

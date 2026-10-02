import net from 'node:net';
import { AuthenticationError, buildPrincipal } from '@bastion-mcp/auth';
import { loadConfig } from '@bastion-mcp/core';
import type { SandboxDriver } from '@bastion-mcp/sandbox';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { createGuardService } from '../../src/adapters/guards';
import { createLimitService } from '../../src/adapters/limits';
import { createPolicyService } from '../../src/adapters/policy';
import type { AuthServices, WorkerServices } from '../../src/contracts';
import { createInfra, type Infra } from '../../src/infra';
import { createWorker } from '../../src/roles/worker';
import type { TestEnv } from './env';

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const KEYRING = { activeKid: 'k1', keys: new Map([['k1', Buffer.alloc(32, 9)]]) };

/**
 * Stand-in for F1's auth services in worker-level tests: bearer tokens of the form `tok:<userId>` map to active
 * users of the database; credentials are the `none` mode. Everything else of the worker is real.
 */
export const stubAuth = (infra: Infra): AuthServices =>
  ({
    stateKeyring: KEYRING,
    setInstanceStopper: () => undefined,
    credentials: {
      resolve: async () => ({ injections: [], credentialHash: 'none', expiresAt: null }),
    },
    verifier: {
      async verify(authorization: string | undefined) {
        const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1] ?? '';
        const id = token.startsWith('tok:') ? token.slice(4) : '';
        const user = id ? await infra.repos.users.get(id) : null;
        if (user?.status !== 'active') {
          throw new AuthenticationError(
            'INVALID_TOKEN',
            'invalid token',
            'Bearer error="invalid_token", resource_metadata="https://bastion.test/.well-known/oauth-protected-resource/mcp"',
          );
        }
        return buildPrincipal(
          { id: user.id, type: 'user', orgRole: user.orgRole, teams: [], active: true },
          { authMethod: 'oauth', clientId: 'test-client', scopes: ['mcp'], credentialId: 'jti' },
        );
      },
    },
  }) as unknown as AuthServices;

export type TestWorker = {
  infra: Infra;
  worker: WorkerServices;
  app: FastifyInstance;
  base: string;
  internalPort: number;
  stop(): Promise<void>;
};

export const startTestWorker = async (
  env: TestEnv,
  options: {
    workerId?: string;
    driver?: SandboxDriver;
    auth?: (infra: Infra) => AuthServices;
  } = {},
): Promise<TestWorker> => {
  const httpPort = await freePort();
  const internalPort = await freePort();
  const config = loadConfig(
    env.env({
      BASTION_ROLE: 'worker',
      BASTION_HTTP_PORT: String(httpPort),
      BASTION_INTERNAL_PORT: String(internalPort),
      BASTION_EGRESS_PORT: String(await freePort()),
    }),
  );
  const infra = createInfra(config, {
    workerId: options.workerId ?? `w-${httpPort}`,
    listenHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    allowInsecureHttp: true,
    ...(options.driver ? { sandboxDriver: options.driver } : {}),
  });
  const auth = (options.auth ?? stubAuth)(infra);
  const policy = createPolicyService(infra);
  const guards = createGuardService(infra);
  const limits = createLimitService(infra);
  const worker = await createWorker(infra, auth, { policy, guards, limits });
  const app = Fastify({ logger: false, forceCloseConnections: true, trustProxy: true });
  await worker.registerRoutes(app);
  await worker.start();
  await app.listen({ port: httpPort, host: '127.0.0.1' });
  return {
    infra,
    worker,
    app,
    base: `http://127.0.0.1:${httpPort}`,
    internalPort,
    async stop() {
      await worker.stop(500).catch(() => undefined);
      await app.close().catch(() => undefined);
      await infra.close();
    },
  };
};

export const connectClient = async (
  base: string,
  userId: string,
  options: { era?: 'modern' | 'legacy'; path?: string } = {},
): Promise<Client> => {
  const client = new Client(
    { name: 'server-test', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: options.era === 'legacy' ? { mode: 'legacy' } : { mode: 'auto' },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${options.path ?? '/mcp'}`), {
      requestInit: { headers: { Authorization: `Bearer tok:${userId}` } },
    }),
  );
  return client;
};

export const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

/** Seeds a user, a published catalog entry with `spec`, and the user's installation of it. */
export const seedInstallation = async (
  infra: Infra,
  input: {
    email: string;
    slug: string;
    spec: Record<string, unknown>;
    userId?: string;
    runtime?: Record<string, unknown>;
  },
): Promise<{ userId: string; entryId: string; versionId: string; installationId: string }> => {
  const user =
    (input.userId ? await infra.repos.users.get(input.userId) : null) ??
    (await infra.repos.users.findByEmail(input.email)) ??
    (await infra.repos.users.create({ email: input.email, displayName: input.email }));
  const entry = await infra.repos.catalogEntries.create({
    slug: input.slug,
    displayName: input.slug,
    description: `${input.slug} test server`,
    createdBy: user.id,
    visibility: { orgWide: true },
  } as never);
  const version = await infra.repos.catalogVersions.create({
    entryId: entry.id,
    label: '1.0.0',
    serverSpec: input.spec,
    installForm: {},
    createdBy: user.id,
    ...(input.runtime ? { runtime: input.runtime } : {}),
  });
  await infra.repos.catalogVersions.publish(version.id);
  const installation = await infra.repos.installations.create({
    ownerType: 'user',
    ownerId: user.id,
    catalogEntryId: entry.id,
    catalogVersionId: version.id,
    slug: input.slug,
    displayName: input.slug,
  });
  return {
    userId: user.id,
    entryId: entry.id,
    versionId: version.id,
    installationId: installation.id,
  };
};

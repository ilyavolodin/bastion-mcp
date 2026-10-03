/**
 * A complete worker for integration tests: real Fastify on an ephemeral port, real Redis, a real `createUpstreamRuntime`
 * against the fake upstreams of `@bastion-mcp/testkit`, and the real `createDownstream`.
 */
import { AuthenticationError, buildPrincipal, type Principal } from '@bastion-mcp/auth';
import { type Keyring, parseServerSpec } from '@bastion-mcp/core';
import { createGuardRegistry, GuardPipeline, type ProfileLayers } from '@bastion-mcp/guards';
import { createRedisLimiter, type Rule } from '@bastion-mcp/limits';
import {
  createUpstreamRuntime,
  type ResolvedInstallation,
  type UpstreamRuntime,
} from '@bastion-mcp/mcp-upstream';
import type { EndpointDefinition, EndpointPolicy, InstallationInfo } from '@bastion-mcp/router';
import type { CallLogRow } from '@bastion-mcp/telemetry';
import {
  type FakeLegacyHttpServer,
  type FakeModernServer,
  freePort,
  startFakeLegacyHttpServer,
  startFakeModernServer,
} from '@bastion-mcp/testkit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { createDownstream, type Downstream, type DownstreamDeps } from '../../src/downstream';
import type { SkillsProvider } from '../../src/ports';
import { allowAllPolicy, installation, uuidFor } from './fixtures';
import { FakeSandboxDriver } from './upstream-fake-sandbox';
import {
  connectUrls,
  FakeCredentials,
  MemoryInstallations,
  MemoryInstanceRepository,
  MemorySnapshotStore,
  MemoryStatusSink,
  MemoryTokenStore,
} from './upstream-memory-ports';

export const stateKeyring: Keyring = {
  activeKid: 'k1',
  keys: new Map([['k1', Buffer.alloc(32, 7)]]),
};
const SECRET = 's'.repeat(40);
const LOOPBACK = { privateCidrs: ['127.0.0.0/8'], insecureHosts: ['127.0.0.1'] };

export type UpstreamKind = 'modern' | 'legacy' | 'sse' | 'stdio';

export type TestUser = { name: string; id: string; token: string; scopes?: string[] };

export type StackOptions = {
  redisUrl: string;
  /** Installations every user owns, one per entry. */
  upstreams: {
    slug: string;
    kind: UpstreamKind;
    url?: string;
    installation?: Partial<InstallationInfo>;
  }[];
  policy?: EndpointPolicy;
  guardLayers?: ProfileLayers;
  rules?: Rule[];
  skills?: SkillsProvider;
  keepAliveMs?: number;
  flood?: { mcpPerMinute: number; oauthPerMinute: number };
  workerId?: string;
  /** Share a runtime world between several stacks (multi-worker tests). */
  shared?: SharedWorld;
  users?: string[];
  config?: Partial<DownstreamDeps['config']>;
  /** Named endpoints per user, given that user's installation ids. */
  named?: (installationIds: string[]) => EndpointDefinition[];
};

export type SharedWorld = {
  repo: MemoryInstanceRepository;
  tokens: MemoryTokenStore;
  driver: FakeSandboxDriver;
  status: MemoryStatusSink;
  installations: MemoryInstallations;
  credentials: FakeCredentials;
  snapshots: MemorySnapshotStore;
};

export const newSharedWorld = (): SharedWorld => ({
  repo: new MemoryInstanceRepository(),
  tokens: new MemoryTokenStore(),
  driver: new FakeSandboxDriver(),
  status: new MemoryStatusSink(),
  installations: new MemoryInstallations(),
  credentials: new FakeCredentials(),
  snapshots: new MemorySnapshotStore(),
});

export type Stack = {
  base: string;
  url: (path?: string) => string;
  app: FastifyInstance;
  downstream: Downstream;
  runtime: UpstreamRuntime;
  redis: Redis;
  rows: CallLogRow[];
  users: Record<string, TestUser>;
  world: SharedWorld;
  rules: Rule[];
  guardLayers: { current: ProfileLayers };
  stop(): Promise<void>;
};

export const userOf = (name: string, scopes: string[] = ['mcp']): TestUser => ({
  name,
  id: uuidFor(`user-${name}`),
  token: `tok-${name}`,
  scopes,
});

const principalOf = (user: TestUser): Principal =>
  buildPrincipal(
    { id: user.id, type: 'user', orgRole: 'member', teams: [], active: true },
    {
      authMethod: 'oauth',
      clientId: 'test-client',
      scopes: user.scopes ?? ['mcp'],
      credentialId: `jti-${user.name}`,
    },
  );

export const startStack = async (options: StackOptions): Promise<Stack> => {
  const world = options.shared ?? newSharedWorld();
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: 2 });
  const workerId = options.workerId ?? 'w1';
  const users = Object.fromEntries((options.users ?? ['alice', 'bob']).map((n) => [n, userOf(n)]));

  const infos = new Map<string, InstallationInfo[]>();
  for (const user of Object.values(users)) {
    const list: InstallationInfo[] = [];
    for (const u of options.upstreams) {
      const slug = u.slug;
      const info = installation(slug, {
        owner: { kind: 'user', id: user.id },
        ...u.installation,
      });
      // One installation per user and upstream: ids are unique per user.
      const id = uuidFor(`inst-${slug}-${user.name}`);
      const withId: InstallationInfo = {
        ...info,
        id,
        catalogSlug: u.installation?.catalogSlug ?? slug,
      };
      list.push(withId);
      const spec =
        u.kind === 'stdio'
          ? parseServerSpec({
              type: 'package',
              runtime: 'npm',
              identifier: 'fake-stdio',
              version: '1.0.0',
              auth: { mode: 'none' },
            })
          : parseServerSpec({
              type: 'remote',
              transport: u.kind === 'sse' ? 'sse' : 'streamable-http',
              url: u.url ?? '',
              auth: { mode: 'none' },
            });
      const resolved: ResolvedInstallation = {
        installationId: id,
        slug,
        catalogEntryId: withId.catalogEntryId,
        catalogVersionId: withId.catalogVersionId ?? uuidFor(`ver-${slug}`),
        catalogEntryName: slug,
        origin: 'admin',
        ownerUserId: user.id,
        spec,
        variables: {},
        configHash: `cfg-${slug}`,
        enableSampling: true,
        enableRoots: true,
        roots: u.kind === 'stdio' ? ['file:///workspace'] : [],
        extensions: {},
        replicas: 1,
      };
      world.installations.add(resolved);
    }
    infos.set(user.id, list);
  }

  const port = await freePort();
  const runtime = createUpstreamRuntime({
    redis: redis as never,
    workerId,
    address: `127.0.0.1:${port}`,
    role: 'worker',
    version: '9.9.9',
    internalSecret: SECRET,
    stateKeyring,
    repo: world.repo,
    tokens: world.tokens,
    driver: world.driver,
    status: world.status,
    installations: world.installations,
    credentials: world.credentials,
    connectUrls,
    snapshots: world.snapshots,
    remote: { ...LOOPBACK },
    limits: { maxRunningPerUser: 10, maxRunningTotal: 500 },
    egressAddress: '10.1.2.3:3128',
  });
  await runtime.start();
  const rpc = await runtime.rpcServer.listen(port, '127.0.0.1');

  const rows: CallLogRow[] = [];
  const rules: Rule[] = [...(options.rules ?? [])];
  const guardLayers = { current: options.guardLayers ?? ({} as ProfileLayers) };
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const httpPort = await freePort();
  const base = `http://127.0.0.1:${httpPort}`;

  const downstream = createDownstream({
    config: {
      publicUrl: base,
      authorizationServers: [`${base}/oauth`],
      serverVersion: '1.2.3',
      orgDisplayName: 'Acme',
      keepAliveMs: options.keepAliveMs ?? 25_000,
      ...(options.flood ? { flood: options.flood } : {}),
      ...options.config,
    },
    upstream: (await import('../../src/upstream-port')).upstreamPortFrom(runtime, {
      installations: world.installations,
      credentials: world.credentials,
    }),
    installations: world.installations,
    items: runtime.lists,
    reads: runtime.lists.reads,
    workers: runtime.registry,
    forwarder: runtime.rpcClient,
    redis: redis as never,
    verifier: {
      verify: async (authorization) => {
        const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
        const user = Object.values(users).find((u) => u.token === token);
        if (!user) {
          throw new AuthenticationError(
            'INVALID_TOKEN',
            'invalid token',
            `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
          );
        }
        return principalOf(user);
      },
    },
    endpointData: {
      configVersion: () => '1',
      load: async (principal) => {
        const list = infos.get(principal.id) ?? [];
        return {
          installations: list,
          namedEndpoints: options.named ? options.named(list.map((i) => i.id)) : [],
        };
      },
    },
    policy: { current: () => options.policy ?? allowAllPolicy },
    stateKeyring,
    limiter: createRedisLimiter({ redis: redis as never }),
    limitRules: { rulesFor: () => rules },
    guards: new GuardPipeline({ guards: createGuardRegistry(), clock: { now: () => Date.now() } }),
    guardProfiles: { layersFor: () => guardLayers.current },
    callLog: { append: (row) => void rows.push(row) },
    ...(options.skills ? { skills: options.skills } : {}),
  });
  (
    runtime.service as { sessionResponse?: (id: string, m: unknown) => Promise<void> }
  ).sessionResponse = (id, m) => downstream.deliverSessionResponse(id, m);
  await downstream.start();
  await downstream.registerRoutes(app);
  await app.listen({ port: httpPort, host: '127.0.0.1' });

  return {
    base,
    url: (path = '/mcp') => `${base}${path}`,
    app,
    downstream,
    runtime,
    redis,
    rows,
    users,
    world,
    rules,
    guardLayers,
    async stop() {
      await downstream.shutdown({ graceMs: 500 }).catch(() => undefined);
      await app.close().catch(() => undefined);
      await runtime.stop(500).catch(() => undefined);
      await rpc.close().catch(() => undefined);
      redis.disconnect();
    },
  };
};

export type Fakes = { modern: FakeModernServer; legacy: FakeLegacyHttpServer };

export const startFakes = async (): Promise<Fakes> => ({
  modern: await startFakeModernServer(),
  legacy: await startFakeLegacyHttpServer(),
});

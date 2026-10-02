import type { PatRecord } from '@bastion-mcp/auth';
import { PolicyEngine } from '@bastion-mcp/policy';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApi } from '../../src/app';
import type { RouteDefinition } from '../../src/framework/route';
import type { ApiDeps } from '../../src/ports';
import {
  fakePrincipalStore,
  fakeSessions,
  fakeTokens,
  MemoryEventBus,
  MemoryRedis,
  MemorySecrets,
  makePatService,
  notConfigured,
  RecordingPublisher,
} from './fakes/base';
import { fakeCatalogDeps } from './fakes/catalog';
import { fakeGuardsDeps } from './fakes/guards';
import { fakeIdentityDeps } from './fakes/identity';
import { fakeInstallationsDeps } from './fakes/installations';
import { fakeLimitsDeps } from './fakes/limits';
import { fakeObservabilityDeps } from './fakes/observability';
import { fakePluginsDeps } from './fakes/plugins';
import { fakeRegistryDeps } from './fakes/registry';
import { fakeSystemDeps } from './fakes/system';
import { MemoryStore } from './memory-store';
import { MemoryUnitOfWork } from './memory-uow';
import { seedCatalog } from './seeds/catalog';
import { seedIdentity } from './seeds/identity';
import { seedInstallations } from './seeds/installations';
import { seedRegistry } from './seeds/registry';
import { type ActorName, seedWorld, tokenFor, W } from './world';

export type FakeCtx = {
  store: MemoryStore;
  clock: { now(): Date };
  newId(): string;
};

export const BASE_URL = 'https://bastion.test';

export type CallOptions = {
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

export type ApiResult = {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | number | undefined>;
  raw: string;
};

export type TestApi = {
  app: FastifyInstance;
  deps: ApiDeps;
  store: MemoryStore;
  uow: MemoryUnitOfWork;
  publisher: RecordingPublisher;
  events: MemoryEventBus;
  redis: MemoryRedis;
  secrets: MemorySecrets;
  patRows: Map<string, PatRecord>;
  call(
    actor: ActorName,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: CallOptions,
  ): Promise<ApiResult>;
  /** Restores the freshly seeded state (cheap alternative to rebuilding the app per case). */
  reset(): void;
  close(): Promise<void>;
};

export type HarnessOptions = {
  routes?: readonly RouteDefinition[];
  overrides?: Partial<ApiDeps>;
  /** Extra seeding after the shared world. */
  seed?: (store: MemoryStore) => Promise<void>;
};

const visibilityOf = (v: unknown) => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
  return { org: o.org === true, teamIds: list(o.teamIds), userIds: list(o.userIds) };
};

/** Policy data of the shared world: teams, catalog entries and installations from the store (10.3). */
export const policyDataFromStore = async (store: MemoryStore) => {
  const entries = await store.find('catalog_entries', {});
  const installs = await store.find('installations', {});
  const users = await store.find('users', {});
  const markets = await store.find('marketplaces', {});
  return {
    orgId: 'org',
    orgWidePublisherIds: users.filter((u) => u.catalogPublishOrgWide === true).map((u) => u.id),
    teams: [
      { id: W.teamA, slug: 'team-a' },
      { id: W.teamB, slug: 'team-b' },
    ],
    catalogEntries: entries
      .map((e) => ({
        id: e.id,
        ...(typeof e.ownerTeamId === 'string' ? { ownerTeamId: e.ownerTeamId } : {}),
        visibility: visibilityOf(e.visibility),
      }))
      .concat(
        // A marketplace audience is Cedar visibility of the pseudo catalog entry `marketplace:{id}` (25.4).
        markets.map((m) => ({
          id: `marketplace:${m.id}`,
          ...(typeof m.ownerTeamId === 'string' ? { ownerTeamId: m.ownerTeamId } : {}),
          visibility: visibilityOf(m.audience),
        })),
      ),
    installations: installs.flatMap((i) =>
      typeof i.catalogEntryId === 'string' && typeof i.ownerId === 'string'
        ? [
            {
              id: i.id,
              catalogEntryId: i.catalogEntryId,
              ...(i.ownerType === 'user' ? { ownerUserId: i.ownerId } : {}),
              ...(i.ownerType === 'team' ? { ownerTeamId: i.ownerId } : {}),
              ...(i.ownerType === 'service' ? { ownerServiceId: i.ownerId } : {}),
            },
          ]
        : [],
    ),
  };
};

/** Engines are expensive to build; reuse one per distinct policy data (the store snapshot after seeding). */
const engines = new Map<string, PolicyEngine>();
const engineFor = (data: Awaited<ReturnType<typeof policyDataFromStore>>): PolicyEngine => {
  const key = JSON.stringify(data);
  let engine = engines.get(key);
  if (!engine) {
    engine = PolicyEngine.create(data);
    engines.set(key, engine);
  }
  return engine;
};

/** Builds the API over in-memory ports and the real Cedar `PolicyEngine` (23.3). */
export const buildTestApi = async (options: HarnessOptions = {}): Promise<TestApi> => {
  const store = new MemoryStore();
  await seedWorld(store);
  await seedCatalog(store);
  await seedInstallations(store);
  await seedRegistry(store);
  await seedIdentity(store);
  if (options.seed) await options.seed(store);
  const uow = new MemoryUnitOfWork(store);
  let counter = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 5, 1, 12, 0, 0)) };
  const newId = () => `id-${++counter}`;
  const ctx: FakeCtx = { store, clock, newId };
  const currentEngine = async (): Promise<PolicyEngine> =>
    engineFor(await policyDataFromStore(store));
  const publisher = new RecordingPublisher();
  const events = new MemoryEventBus();
  const redis = new MemoryRedis();
  const secrets = new MemorySecrets();
  const patsFake = makePatService(clock);

  const deps: ApiDeps = {
    config: { baseUrl: BASE_URL, sseHeartbeatMs: 60_000 },
    auth: { tokens: fakeTokens(), sessions: fakeSessions() },
    principals: fakePrincipalStore(),
    policy: {
      engine: currentEngine,
      data: { load: async () => policyDataFromStore(store) },
    },
    store,
    uow,
    redis,
    publisher,
    events,
    pats: patsFake.service,
    deactivation: { execute: async () => {} },
    secrets,
    system: notConfigured('system'),
    identity: notConfigured('identity'),
    account: { changePassword: async () => ({ ok: false, reason: 'invalid_current' }) },
    catalog: notConfigured('catalog'),
    installations: notConfigured('installations'),
    registry: notConfigured('registry'),
    guards: notConfigured('guards'),
    observability: notConfigured('observability'),
    plugins: notConfigured('plugins'),
    limits: notConfigured('limits'),
    clock,
    newId,
    ...fakeCatalogDeps(ctx),
    ...fakeGuardsDeps(ctx),
    ...fakeIdentityDeps(ctx),
    ...fakeLimitsDeps(ctx),
    ...fakeInstallationsDeps(ctx),
    ...fakeObservabilityDeps(ctx),
    ...fakePluginsDeps(ctx),
    ...fakeRegistryDeps(ctx),
    ...fakeSystemDeps(ctx),
    ...options.overrides,
  };

  const seeded = store.snapshot();
  const app = Fastify({ logger: false });
  await registerApi(app, deps, options.routes ? { routes: options.routes } : {});
  await app.ready();

  return {
    app,
    deps,
    store,
    uow,
    publisher,
    events,
    redis,
    secrets,
    patRows: patsFake.pats.rows,
    async call(actor, method, url, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (actor !== 'anonymous' && !headers.authorization && !headers.cookie) {
        headers.authorization = `Bearer ${tokenFor(actor)}`;
      }
      const response = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers,
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
        ...(opts.body !== undefined && !headers['content-type']
          ? { headers: { ...headers, 'content-type': 'application/json' } }
          : {}),
      });
      let body: unknown = response.body;
      try {
        body = response.body.length > 0 ? JSON.parse(response.body) : null;
      } catch {
        body = response.body;
      }
      return { status: response.statusCode, body, headers: response.headers, raw: response.body };
    },
    reset() {
      store.restore(new Map([...seeded].map(([k, v]) => [k, new Map(v)])));
      uow.audits.length = 0;
      publisher.messages.length = 0;
      events.published.length = 0;
      redis.data.clear();
      patsFake.pats.rows.clear();
    },
    close: () => app.close(),
  };
};

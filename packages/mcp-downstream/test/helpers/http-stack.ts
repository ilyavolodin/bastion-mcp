/**
 * A downstream worker with in-memory fakes for every port (no Docker): real Fastify on an ephemeral port, real
 * `createDownstream`, a scriptable `UpstreamPort`, `FakeRedis`, an in-memory limiter and the real guard pipeline.
 */
import {
  AuthenticationError,
  buildPrincipal,
  InsufficientScopeError,
  type Principal,
} from '@bastion-mcp/auth';
import { createGuardRegistry, GuardPipeline, type ProfileLayers } from '@bastion-mcp/guards';
import { EngineLimiter, MemoryBackend, type Rule } from '@bastion-mcp/limits';
import type {
  EndpointDefinition,
  EndpointPolicy,
  InstallationInfo,
  UpstreamItems,
} from '@bastion-mcp/router';
import type { CallLogRow } from '@bastion-mcp/telemetry';
import { freePort } from '@bastion-mcp/testkit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDownstream, type Downstream, type DownstreamConfig } from '../../src/downstream';
import type { CatalogInstallPort, SkillsProvider, TokenVerifierPort } from '../../src/ports';
import { FakeRedis } from './fake-redis';
import { allowAllPolicy, installation, items, sourceOf, uuidFor } from './fixtures';
import { FakeUpstream, keyring } from './ops';

export type HttpStackOptions = {
  installs?: { slug: string; items?: UpstreamItems; info?: Partial<InstallationInfo> }[];
  policy?: EndpointPolicy;
  rules?: Rule[];
  guardLayers?: ProfileLayers;
  skills?: SkillsProvider;
  catalogInstall?: CatalogInstallPort;
  named?: EndpointDefinition[];
  flood?: { mcpPerMinute: number; oauthPerMinute: number };
  config?: Partial<DownstreamConfig>;
  /** Tokens that map to a principal; `expired`, `revoked` and friends are modelled by the verifier throwing. */
  verifier?: TokenVerifierPort;
  users?: string[];
  /** Pre-picked port, when a verifier needs the base URL up front. */
  port?: number;
};

export type HttpStack = {
  base: string;
  app: FastifyInstance;
  downstream: Downstream;
  upstream: FakeUpstream;
  redis: FakeRedis;
  rows: CallLogRow[];
  rules: Rule[];
  guardLayers: { current: ProfileLayers };
  users: Record<string, { id: string; token: string }>;
  installs: InstallationInfo[];
  stop(): Promise<void>;
};

export const challenge = (base: string, error?: 'invalid_token' | 'insufficient_scope'): string =>
  `Bearer ${error ? `error="${error}", ` : ''}resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`;

const principalFor = (id: string): Principal =>
  buildPrincipal(
    { id, type: 'user', orgRole: 'member', teams: [], active: true },
    { authMethod: 'oauth', clientId: 'client-1', scopes: ['mcp'], credentialId: 'jti' },
  );

export { freePort };

export const startHttpStack = async (options: HttpStackOptions = {}): Promise<HttpStack> => {
  const users = Object.fromEntries(
    (options.users ?? ['alice', 'bob']).map((n) => [
      n,
      { id: uuidFor(`user-${n}`), token: `tok-${n}` },
    ]),
  );
  const slugs = options.installs ?? [{ slug: 'github' }];
  const installs = (userId: string): InstallationInfo[] =>
    slugs.map((s) => ({
      ...installation(s.slug, {
        owner: { kind: 'user', id: userId },
        catalogSlug: s.slug,
        ...s.info,
      }),
      id: uuidFor(`inst-${s.slug}-${userId}`),
    }));
  const itemsFor = (userId: string): Record<string, UpstreamItems> =>
    Object.fromEntries(installs(userId).map((i, idx) => [i.id, slugs[idx]?.items ?? items()]));

  const port = options.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const redis = new FakeRedis();
  const upstream = new FakeUpstream();
  const rows: CallLogRow[] = [];
  const rules: Rule[] = [...(options.rules ?? [])];
  const guardLayers = { current: options.guardLayers ?? ({} as ProfileLayers) };
  const app = Fastify({ logger: false, forceCloseConnections: true });

  const verifier: TokenVerifierPort = options.verifier ?? {
    verify: async (authorization) => {
      const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
      const user = Object.values(users).find((u) => u.token === token);
      if (!user) {
        throw new AuthenticationError(
          'INVALID_TOKEN',
          'invalid token',
          challenge(base, 'invalid_token'),
        );
      }
      return principalFor(user.id);
    },
  };

  const sourceByUser = new Map<string, ReturnType<typeof sourceOf>>();
  const sourceFor = (userId: string) => {
    let s = sourceByUser.get(userId);
    if (!s) {
      s = sourceOf(itemsFor(userId));
      sourceByUser.set(userId, s);
    }
    return s;
  };

  const downstream = createDownstream({
    config: {
      publicUrl: base,
      authorizationServers: [`${base}/oauth`],
      serverVersion: '1.2.3',
      orgDisplayName: 'Acme',
      keepAliveMs: 5000,
      ...(options.flood ? { flood: options.flood } : {}),
      ...options.config,
    },
    upstream,
    installations: { get: async () => null },
    items: {
      listItems: (info, ctx) => sourceFor(ctx.principalId).listItems(info, ctx),
    },
    workers: { workerId: 'w1', lookup: async () => null },
    forwarder: { forwardSessionResponse: async () => undefined },
    redis,
    verifier,
    endpointData: {
      configVersion: () => '1',
      load: async (principal) => ({
        installations: installs(principal.id),
        namedEndpoints: options.named ?? [],
      }),
    },
    policy: { current: () => options.policy ?? allowAllPolicy },
    stateKeyring: keyring,
    limiter: new EngineLimiter(new MemoryBackend(1)),
    limitRules: { rulesFor: () => rules },
    guards: new GuardPipeline({ guards: createGuardRegistry(), clock: { now: () => Date.now() } }),
    guardProfiles: { layersFor: () => guardLayers.current },
    callLog: { append: (row) => void rows.push(row) },
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.catalogInstall ? { catalogInstall: options.catalogInstall } : {}),
  });
  await downstream.start();
  await downstream.registerRoutes(app);
  await app.listen({ port, host: '127.0.0.1' });
  return {
    base,
    app,
    downstream,
    upstream,
    redis,
    rows,
    rules,
    guardLayers,
    users,
    installs: installs(users.alice?.id ?? ''),
    async stop() {
      await downstream.shutdown({ graceMs: 200 }).catch(() => undefined);
      await app.close().catch(() => undefined);
    },
  };
};

export { InsufficientScopeError };

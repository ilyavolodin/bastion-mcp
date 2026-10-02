import { randomBytes } from 'node:crypto';
import type { OAuthMetrics, RefreshOutcome } from '../../src/oauth/metrics';
import { createSafeFetch } from '../../src/oauth/safe-fetch';
import {
  type BrokerDeps,
  type OAuthInstallation,
  UpstreamOAuthBroker,
  type UpstreamPrincipal,
} from '../../src/oauth/upstream/broker';
import { type FakeUpstream, type FakeUpstreamBehavior, startFakeUpstream } from './fake-upstream';
import {
  MemoryRedis,
  MemorySecrets,
  MemorySigningKeys,
  MemoryUpstreamClients,
  MemoryUpstreamTokens,
} from './fakes';

export const HOST = 'bastion.test';
export const LOOPBACK_POLICY = {
  addressPolicy: { allowCidrs: ['127.0.0.0/8'] },
  allowHttpToAllowedCidrs: true,
};

export const USER: UpstreamPrincipal = { type: 'user', id: 'user-1' };

export type UpstreamHarness = {
  upstream: FakeUpstream;
  broker: UpstreamOAuthBroker;
  installation: OAuthInstallation;
  secrets: MemorySecrets;
  clients: MemoryUpstreamClients;
  tokens: MemoryUpstreamTokens;
  signingKeys: MemorySigningKeys;
  redis: MemoryRedis;
  clock: { t: number; now(): number };
  outcomes: RefreshOutcome[];
  deps: BrokerDeps;
  installations: Map<string, OAuthInstallation>;
  /** Runs the whole browser flow for a principal. */
  connect(principal?: UpstreamPrincipal, installation?: OAuthInstallation): Promise<void>;
  close(): Promise<void>;
};

export const startUpstreamHarness = async (
  upstreamOverrides: Partial<FakeUpstreamBehavior> = {},
  auth: Partial<OAuthInstallation['auth']> = {},
  depOverrides: Partial<BrokerDeps> = {},
): Promise<UpstreamHarness> => {
  const upstream = await startFakeUpstream(upstreamOverrides);
  const secrets = new MemorySecrets();
  const clients = new MemoryUpstreamClients();
  const tokens = new MemoryUpstreamTokens();
  const signingKeys = new MemorySigningKeys();
  signingKeys.add(
    new Date(Date.now() - 86_400_000),
    new Date(Date.now() + 90 * 86_400_000),
    'upstream-client',
  );
  const redis = new MemoryRedis();
  const clock = { t: Date.now(), now: () => clock.t };
  const outcomes: RefreshOutcome[] = [];
  const metrics: OAuthMetrics = { recordRefresh: (o) => outcomes.push(o) };
  const installation: OAuthInstallation = {
    id: 'inst-1',
    name: 'Fake MCP',
    kind: 'remote',
    upstreamUrl: upstream.mcpUrl,
    auth: { mode: 'oauth', client: { registration: 'dcr' }, scopes: ['read'], ...auth },
  };
  const installations = new Map([[installation.id, installation]]);
  const deps: BrokerDeps = {
    host: HOST,
    orgName: 'Acme',
    stateKeyring: { activeKid: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
    secrets,
    clients,
    tokens,
    signingKeys,
    redis,
    installations: { get: async (id) => installations.get(id) ?? null },
    fetch,
    outbound: LOOPBACK_POLICY,
    allowInsecureHttp: true,
    clock,
    metrics,
    ...depOverrides,
  };
  const broker = new UpstreamOAuthBroker(deps);
  return {
    upstream,
    broker,
    installation,
    secrets,
    clients,
    tokens,
    signingKeys,
    redis,
    clock,
    outcomes,
    deps,
    installations,
    async connect(principal = USER, target = installation) {
      const { authorizationUrl } = await broker.startAuthorization(principal, target);
      const query = await upstream.authorize(authorizationUrl);
      await broker.completeAuthorization(principal, query);
    },
    close: () => upstream.close(),
  };
};

export const safeLoopbackFetch = () => createSafeFetch(fetch, LOOPBACK_POLICY);

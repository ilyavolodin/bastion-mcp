/**
 * Compose root of the downstream layer (`createDownstream`): wires the operation layer, both adapters, the listen
 * handler, the notify hub and the Fastify plugin, and implements the graceful shutdown of 21.2.
 */
import { newId } from '@bastion-mcp/core';
import { FloodLimiter, type Limiter } from '@bastion-mcp/limits';
import type { GuardPipeline } from '@bastion-mcp/guards';
import type { Keyring } from '@bastion-mcp/core';
import { type InstallationRegistry, InflightTracker } from '@bastion-mcp/mcp-upstream';
import {
  EndpointCache,
  RedisSeenUriStore,
  resolveResourceUriWithSeen,
  type SeenUriStore,
  type UpstreamItemSource,
} from '@bastion-mcp/router';
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import type { Tracer } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import type { LegacyAdapter, ListenAdapter } from './adapters/contracts';
import { createLegacyAdapter } from './adapters/legacy';
import { createDirectHandler } from './adapters/modern/direct';
import { createListenAdapter } from './adapters/modern/listen';
import { createModernAdapter, type ModernAdapter } from './adapters/modern/server';
import type { BastionRequestContext } from './context';
import { EndpointResolver } from './http/resolver';
import { registerMcpRoutes } from './http/plugin';
import { NotifyHub } from './notify-hub';
import {
  DEFAULT_SETTINGS,
  defaultGuardProfilePort,
  defaultLimitRulesPort,
  defaultToPolicyPrincipal,
  defaultTracer,
  noopMetrics,
  type OperationDeps,
  type ReadCachePort,
} from './operations/deps';
import { createOperations, createOpRunner } from './operations/registry';
import { installationDataOf, policyContextOf } from './operations/support';
import {
  type CallLogPort,
  type CatalogInstallPort,
  type Clock,
  type DownstreamRedis,
  type EndpointDataPort,
  type GuardProfilePort,
  type LimitRulesPort,
  type Logger,
  noopLogger,
  type PolicyPort,
  type PrincipalProfilePort,
  type SessionResponseForwarder,
  type SkillsProvider,
  systemClock,
  type ToPolicyPrincipal,
  type TokenVerifierPort,
  type UpstreamPort,
  type WorkerDirectory,
} from './ports';

export type DownstreamConfig = {
  /** `BASTION_PUBLIC_URL`. */
  publicUrl: string;
  /** Authorization servers named in the Protected Resource Metadata (the AS issuer, `https://<host>/oauth`). */
  authorizationServers: string[];
  serverVersion: string;
  orgDisplayName: string;
  /** `BASTION_LEGACY_MAX_SESSIONS_PER_PRINCIPAL` (default 20). */
  legacyMaxSessionsPerPrincipal?: number;
  /** `BASTION_LIST_PAGE_SIZE` (default 1,000). */
  listPageSize?: number;
  /** `BASTION_OTEL_CAPTURE_CONTENT`. */
  captureContent?: boolean;
  orgId?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  scopesSupported?: string[];
  /** SSE keep-alive comments every 25 s (6.2); tests lower it. */
  keepAliveMs?: number;
  /** Pre-auth flood limits per minute (14.2). */
  flood?: { mcpPerMinute: number; oauthPerMinute: number };
};

export type DownstreamDeps = {
  config: DownstreamConfig;
  // --- the upstream half (`createUpstreamRuntime`) -------------------------------------------------------------
  upstream: UpstreamPort;
  installations: Pick<InstallationRegistry, 'get'>;
  /** `runtime.lists`: implements the router's `UpstreamItemSource`; `reads` backs the public read cache (6.7). */
  items: UpstreamItemSource;
  reads?: ReadCachePort;
  /** `runtime.registry` and `runtime.rpcClient`. */
  workers: WorkerDirectory;
  forwarder: SessionResponseForwarder;
  redis: DownstreamRedis;
  // --- identity, routing, policy ---------------------------------------------------------------------------------
  verifier: TokenVerifierPort;
  endpointData: EndpointDataPort;
  policy: PolicyPort;
  endpointCache?: EndpointCache;
  profiles?: PrincipalProfilePort;
  toPolicyPrincipal?: ToPolicyPrincipal;
  catalogInstall?: CatalogInstallPort;
  skills?: SkillsProvider;
  stateKeyring: Keyring;
  // --- limits, guards, call log ------------------------------------------------------------------------------------
  limiter: Limiter;
  limitRules?: LimitRulesPort;
  guards: GuardPipeline;
  guardProfiles?: GuardProfilePort;
  seenUris?: SeenUriStore;
  callLog: CallLogPort;
  // --- telemetry -------------------------------------------------------------------------------------------------
  metrics?: BastionMetrics;
  tracer?: Tracer;
  logger?: Logger;
  clock?: Clock;
};

export type Downstream = {
  /** Registers the MCP routes on a Fastify instance (worker role). */
  registerRoutes(app: FastifyInstance): Promise<void>;
  /** `UpstreamService.sessionResponse`: delivers a legacy client's answer routed here by the internal RPC (6.5). */
  deliverSessionResponse(sessionId: string, message: unknown): Promise<void>;
  /** Starts the per-worker Redis subscription (6.6). Idempotent. */
  start(): Promise<void>;
  /** 21.2: drain in-flight exchanges, answer listen streams with a final `complete`, end legacy SSE streams. */
  shutdown(options?: { graceMs?: number }): Promise<void>;
  /** For tests and health: open streams per kind. */
  streams(): { listen: number; legacy: number };
  readonly endpointCache: EndpointCache;
  readonly operations: ReturnType<typeof createOperations>;
  readonly run: ReturnType<typeof createOpRunner>;
  readonly hub: NotifyHub;
  readonly modern: ModernAdapter;
  readonly legacy: LegacyAdapter;
  readonly listen: ListenAdapter;
};

export const createDownstream = (deps: DownstreamDeps): Downstream => {
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? systemClock;
  const metrics = deps.metrics ?? noopMetrics();
  const tracer = deps.tracer ?? defaultTracer();
  const config = deps.config;
  const seenUris = deps.seenUris ?? new RedisSeenUriStore(deps.redis);
  const endpointCache =
    deps.endpointCache ??
    new EndpointCache({ onCompile: (seconds) => metrics.configCompileDuration.record(seconds) });
  const toPolicyPrincipal = deps.toPolicyPrincipal ?? defaultToPolicyPrincipal;

  const operationDeps: OperationDeps = {
    upstream: deps.upstream,
    stateKeyring: deps.stateKeyring,
    policy: deps.policy,
    toPolicyPrincipal,
    profiles: deps.profiles,
    limiter: deps.limiter,
    limitRules: deps.limitRules ?? defaultLimitRulesPort,
    guards: deps.guards,
    guardProfiles: deps.guardProfiles ?? defaultGuardProfilePort,
    seenUris,
    callLog: deps.callLog,
    skills: deps.skills,
    installations: deps.installations,
    reads: deps.reads,
    metrics,
    tracer,
    clock,
    logger,
    newId,
    settings: {
      ...DEFAULT_SETTINGS,
      serverVersion: config.serverVersion,
      ...(config.listPageSize === undefined ? {} : { listPageSize: config.listPageSize }),
      ...(config.captureContent === undefined ? {} : { captureContent: config.captureContent }),
      ...(config.orgId === undefined ? {} : { orgId: config.orgId }),
    },
  };
  const operations = createOperations(operationDeps);
  const run = createOpRunner(operationDeps, operations);
  const hub = new NotifyHub({ redis: deps.redis, logger });

  const roots = async (installationId: string): Promise<readonly string[]> =>
    (await deps.installations.get(installationId))?.roots ?? [];

  const legacy = createLegacyAdapter({
    redis: deps.redis,
    hub,
    run,
    workers: deps.workers,
    forwarder: deps.forwarder,
    maxSessionsPerPrincipal: config.legacyMaxSessionsPerPrincipal ?? 20,
    roots,
    metrics,
    logger,
    clock,
    ...(config.keepAliveMs === undefined ? {} : { keepAliveMs: config.keepAliveMs }),
  });

  const canReadUri = async (rc: BastionRequestContext, uri: string) => {
    const target = await resolveResourceUriWithSeen(rc.resolved.endpoint.uriIndex, uri, {
      store: seenUris,
      principalId: rc.principal.id,
      endpointId: rc.resolved.endpoint.endpointId,
    });
    if (!target.ok) return { ok: false as const };
    const installation = rc.resolved.installations.get(target.target.installationId);
    if (!installation) return { ok: false as const };
    // Cedar decides readability the same way `resources/read` does (10.3).
    const profile = deps.profiles ? await deps.profiles.profile(rc.principal) : {};
    const decision = deps.policy.current().authorize({
      principal: toPolicyPrincipal(rc.principal, profile),
      action: 'readResource',
      resource: { type: 'Resource', installation: installationDataOf(installation), uri },
      context: policyContextOf(
        { principal: rc.principal, ip: rc.ip, path: rc.path, clientInfo: undefined },
        clock.now(),
      ),
    });
    return decision.decision === 'allow'
      ? { ok: true as const, installationId: installation.id }
      : { ok: false as const };
  };

  const listen = createListenAdapter({
    hub,
    upstream: deps.upstream,
    canReadUri,
    metrics,
    logger,
    ...(config.keepAliveMs === undefined ? {} : { keepAliveMs: config.keepAliveMs }),
  });
  const modern = createModernAdapter({
    run,
    operationDeps: { skills: deps.skills, logger },
    ...(config.keepAliveMs === undefined ? {} : { keepAliveMs: config.keepAliveMs }),
  });
  const direct = createDirectHandler({ run, serverInfo: (rc) => rc.resolved.endpoint.serverInfo });
  const resolver = new EndpointResolver({
    data: deps.endpointData,
    cache: endpointCache,
    source: deps.items,
    policy: deps.policy,
    toPolicyPrincipal,
    profiles: deps.profiles,
    org: { displayName: config.orgDisplayName },
    serverVersion: config.serverVersion,
    clock,
    logger,
  });
  const flood = new FloodLimiter(config.flood);
  const inflight = new InflightTracker();
  let draining = false;
  let started = false;

  return {
    endpointCache,
    operations,
    run,
    hub,
    modern,
    legacy,
    listen,
    async start() {
      if (started) return;
      started = true;
      await hub.start();
    },
    registerRoutes: (app) =>
      registerMcpRoutes(app, {
        verifier: deps.verifier,
        flood,
        resolver,
        endpointCache,
        catalogInstall: deps.catalogInstall,
        modern,
        legacy,
        listen,
        direct,
        baseUrl: config.publicUrl.replace(/\/+$/, ''),
        authorizationServers: config.authorizationServers,
        ...(config.scopesSupported ? { scopesSupported: config.scopesSupported } : {}),
        ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
        ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
        tracer,
        logger,
        isDraining: () => draining,
        track: (fn) => inflight.track(fn),
      }),
    deliverSessionResponse: (sessionId, message) => legacy.deliverResponse(sessionId, message),
    streams: () => ({ listen: listen.activeStreams(), legacy: legacy.activeStreams() }),
    async shutdown(options = {}) {
      draining = true;
      // In-flight operations finish first (up to the grace period); long-lived streams do not count (21.2).
      await inflight.drain(options.graceMs ?? 25_000);
      await listen.shutdown();
      await legacy.shutdown();
      await modern.close();
      await hub.stop();
    },
  };
};

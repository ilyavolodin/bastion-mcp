import type { Keyring } from '@bastion-mcp/core';
import type { Resolver, SandboxDriver, StderrLogger, StderrSink } from '@bastion-mcp/sandbox';
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import type { Tracer } from '@opentelemetry/api';
import { RemoteAgentRegistry } from './connectors/agent';
import { EraCache } from './connectors/era-cache';
import { HttpConnector } from './connectors/http';
import type { TlsSecretResolver } from './connectors/remote';
import { SandboxConnector } from './connectors/sandbox';
import { SseConnector } from './connectors/sse';
import { RedisEgressPolicyStore } from './instances/egress-store';
import { InstanceManager } from './instances/manager';
import type { InstanceTelemetry } from './instances/telemetry';
import { NotifyPublisher, type UriMapper } from './listen/events';
import { ListenManager } from './listen/manager';
import { UpstreamLists } from './lists/source';
import { LeaseManager } from './ownership/lease';
import { WorkerRegistry } from './ownership/registry';
import type {
  ConnectUrlBuilder,
  EgressPolicyWriter,
  InstallationRegistry,
  InstallationStatusSink,
  InstanceRepository,
  ListChangedPublisher,
  Logger,
  PinChecker,
  RedisLike,
  RunnerTokenStore,
  SnapshotStore,
  UpstreamCredentialProvider,
} from './ports';
import { InternalRpcClient } from './rpc/client';
import { createInternalRpcServer } from './rpc/server';
import { RemotePool } from './service/pool';
import { UpstreamService } from './service/service';

export type UpstreamRuntimeOptions = {
  redis: RedisLike;
  workerId: string;
  /** `<podIP>:7443` */
  address: string;
  role: string;
  version: string;
  /** `BASTION_INTERNAL_SECRET` and `BASTION_INTERNAL_SECRET_PREVIOUS` */
  internalSecret: string;
  previousInternalSecret?: string | undefined;
  stateKeyring: Keyring;
  // storage and platform ports
  repo: InstanceRepository;
  tokens: RunnerTokenStore;
  driver: SandboxDriver;
  egress?: EgressPolicyWriter;
  status: InstallationStatusSink;
  installations: InstallationRegistry;
  credentials: UpstreamCredentialProvider;
  connectUrls: ConnectUrlBuilder;
  snapshots: SnapshotStore;
  pins?: PinChecker;
  changed?: ListChangedPublisher;
  uris?: UriMapper;
  /** `ulisten` tuning: grace before closing an unused listen (default 60 s) and the lease tick (5 s). */
  listen?: { graceMs?: number; tickMs?: number };
  // settings
  remote: {
    privateCidrs: readonly string[];
    insecureHosts: readonly string[];
    resolver?: Resolver;
    tls?: TlsSecretResolver;
    caps?: { messageBytes?: number; streamBytes?: number };
  };
  limits: { maxRunningPerUser: number; maxRunningTotal: number };
  egressAddress: string;
  npmRegistry?: string;
  pypiIndexUrl?: string;
  listCacheTtlMs?: number;
  stderrSink?: StderrSink;
  stderrLogger?: StderrLogger;
  telemetry?: InstanceTelemetry;
  metrics?: BastionMetrics;
  tracer?: Tracer;
  logger?: Logger;
};

/** Wires the upstream half of the gateway for one worker (21.1): registry, leases, instances, RPC, lists, listen. */
export const createUpstreamRuntime = (options: UpstreamRuntimeOptions) => {
  const registry = new WorkerRegistry({
    redis: options.redis,
    workerId: options.workerId,
    address: options.address,
    role: options.role,
    version: options.version,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const leases = new LeaseManager({
    redis: options.redis,
    registry,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const agents = new RemoteAgentRegistry();
  const remoteSettings = {
    privateCidrs: options.remote.privateCidrs,
    insecureHosts: options.remote.insecureHosts,
    ...(options.remote.resolver ? { resolver: options.remote.resolver } : {}),
    ...(options.remote.tls ? { tls: options.remote.tls } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const connectorOptions = {
    agents,
    settings: remoteSettings,
    version: options.version,
    ...(options.remote.caps ? { caps: options.remote.caps } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const http = new HttpConnector(connectorOptions);
  const sse = new SseConnector(connectorOptions);
  const sandbox = new SandboxConnector({
    version: options.version,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const egress = options.egress ?? new RedisEgressPolicyStore(options.redis);
  const instances = new InstanceManager({
    redis: options.redis,
    repo: options.repo,
    tokens: options.tokens,
    driver: options.driver,
    egress,
    status: options.status,
    leases,
    registry,
    connectors: { http, sse, sandbox },
    limits: options.limits,
    egressAddress: options.egressAddress,
    npmRegistry: options.npmRegistry,
    pypiIndexUrl: options.pypiIndexUrl,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    metrics: options.metrics,
    stderrSink: options.stderrSink,
    stderrLogger: options.stderrLogger,
    ...(options.logger ? { logger: options.logger } : {}),
    idleSweepMs: 30_000,
  });
  const eraCache = new EraCache(options.redis);
  const pool = new RemotePool({
    connector: http,
    eraCache,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const rpcClient = new InternalRpcClient({
    secret: options.internalSecret,
    metrics: options.metrics,
    ...(options.tracer ? { tracer: options.tracer } : {}),
  });
  const service = new UpstreamService({
    redis: options.redis,
    registry,
    leases,
    instances,
    pool,
    eraCache,
    rpc: rpcClient,
    installations: options.installations,
    credentials: options.credentials,
    connectUrls: options.connectUrls,
    stateKeyring: options.stateKeyring,
    metrics: options.metrics,
    ...(options.tracer ? { tracer: options.tracer } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const publisher = new NotifyPublisher(options.redis, options.logger);
  const lists = new UpstreamLists({
    service,
    redis: options.redis,
    installations: options.installations,
    credentials: options.credentials,
    snapshots: options.snapshots,
    changed: options.changed ?? publisher,
    pins: options.pins,
    listCacheTtlMs: options.listCacheTtlMs,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const listen = new ListenManager({
    service,
    lists,
    publisher,
    redis: options.redis,
    registry,
    rpc: rpcClient,
    installations: options.installations,
    credentials: options.credentials,
    ...(options.uris ? { uris: options.uris } : {}),
    ...(options.listen?.graceMs === undefined ? {} : { graceMs: options.listen.graceMs }),
    ...(options.listen?.tickMs === undefined ? {} : { tickMs: options.listen.tickMs }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const rpcServer = createInternalRpcServer({
    secret: options.internalSecret,
    previousSecret: options.previousInternalSecret,
    handlers: service,
    ...(options.tracer ? { tracer: options.tracer } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  return {
    registry,
    leases,
    instances,
    pool,
    service,
    lists,
    listen,
    publisher,
    rpcClient,
    rpcServer,
    agents,
    eraCache,
    /** Registers the worker, starts heartbeats and wires lists and listen to new sessions. */
    async start(): Promise<void> {
      lists.attach();
      listen.attach();
      await registry.start();
    },
    /** SIGTERM: drain, close connections (sandboxes keep running), delete leases (21.2). */
    async stop(graceMs?: number): Promise<{ drained: boolean }> {
      await listen.close();
      const result = await service.shutdown(graceMs);
      await agents.closeAll();
      await rpcClient.close();
      return result;
    },
  };
};

export type UpstreamRuntime = ReturnType<typeof createUpstreamRuntime>;

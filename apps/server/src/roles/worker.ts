import { connectUrl as authConnectUrl } from '@bastion-mcp/auth';
import {
  type CatalogInstallPort,
  createDownstream,
  type SkillsProvider,
  upstreamPortFrom,
} from '@bastion-mcp/mcp-downstream';
import { createUpstreamRuntime, type Logger as UpstreamLogger } from '@bastion-mcp/mcp-upstream';
import { EndpointCache } from '@bastion-mcp/router';
import { SettingsCache, watchConfig } from '../adapters/config-watch';
import { createCallLog } from '../adapters/downstream/call-log';
import { createEndpointData, createPrincipalProfiles } from '../adapters/downstream/endpoint-data';
import { createSandboxStack, egressHost } from '../adapters/sandbox';
import { createCredentialProvider } from '../adapters/upstream/credentials';
import { createInstallationRegistry } from '../adapters/upstream/installations';
import { createPinChecker } from '../adapters/upstream/pin-checker';
import { createRunnerTokenStore } from '../adapters/upstream/runner-tokens';
import { createStderrLogger, createStderrSink } from '../adapters/upstream/stderr';
import { publicHost, SERVER_VERSION } from '../config';
import type {
  AuthServices,
  GuardService,
  LimitService,
  PolicyService,
  WorkerServices,
} from '../contracts';
import type { Infra } from '../infra';

type Optional<T> = T & { ready?: () => Promise<void>; watch?: () => () => void };

export type WorkerDeps = {
  policy: Optional<PolicyService>;
  guards: Optional<GuardService>;
  limits: Optional<LimitService>;
  skills?: SkillsProvider | undefined;
  catalogInstall?: CatalogInstallPort | undefined;
};

const upstreamLogger = (infra: Infra): UpstreamLogger => ({
  debug: (m, f) => infra.logger.debug(f ?? {}, m),
  info: (m, f) => infra.logger.info(f ?? {}, m),
  warn: (m, f) => infra.logger.warn(f ?? {}, m),
  error: (m, f) => infra.logger.error(f ?? {}, m),
});

/**
 * The worker role (4.2, 21): the MCP routes, the owner side of upstream instances, the internal RPC listener, the
 * egress proxy and the Redis subscriptions that keep local caches current. `registerRoutes` mounts `/mcp`, `/mcp/*`
 * and `/.well-known/oauth-protected-resource/*`; `start` brings up everything else; `stop` is the SIGTERM drain.
 */
export const createWorker = async (
  infra: Infra,
  auth: AuthServices,
  deps: WorkerDeps,
): Promise<WorkerServices> => {
  const { config } = infra;
  const logger = upstreamLogger(infra);
  const settings = new SettingsCache(infra);
  await settings.refresh();

  const sandbox = await createSandboxStack(infra);
  const installations = createInstallationRegistry(infra);
  const credentials = createCredentialProvider(auth);
  const endpointData = createEndpointData(infra);
  const callLog = createCallLog(infra, settings);
  const profiles = createPrincipalProfiles(infra);
  const pins = createPinChecker(infra, { installations, guards: deps.guards });

  await Promise.all([
    deps.policy.ready?.() ?? deps.policy.rebuild(),
    deps.guards.ready?.(),
    deps.limits.ready?.(),
    endpointData.ready(),
  ]);

  const advertiseHost = infra.options.advertiseHost ?? egressHost(infra);
  const address = `${advertiseHost}:${config.internalPort}`;
  const loopback = infra.options.allowInsecureHttp === true;

  const runtime = createUpstreamRuntime({
    redis: infra.redis,
    workerId: infra.workerId,
    address,
    role: config.role,
    version: SERVER_VERSION,
    internalSecret: config.internalSecret,
    previousInternalSecret: config.internalSecretPrevious,
    stateKeyring: auth.stateKeyring,
    repo: infra.repos.instances,
    tokens: createRunnerTokenStore(infra),
    driver: sandbox.driver,
    status: infra.repos.installations,
    installations,
    credentials,
    connectUrls: {
      connectUrl: (_principal, installationId) =>
        authConnectUrl(publicHost(config), installationId),
    },
    snapshots: infra.repos.snapshots,
    pins,
    remote: {
      privateCidrs: [
        ...config.privateUpstreamCidrs,
        ...(loopback ? ['127.0.0.0/8', '::1/128'] : []),
      ],
      insecureHosts: [
        ...config.insecureUpstreamHosts,
        ...(loopback ? ['127.0.0.1', 'localhost', '::1'] : []),
      ],
    },
    limits: {
      maxRunningPerUser: config.maxRunningInstancesPerUser,
      maxRunningTotal: config.maxRunningSandboxes,
    },
    egressAddress: sandbox.egressAddress,
    npmRegistry: config.npmRegistry,
    pypiIndexUrl: config.pypiIndexUrl,
    listCacheTtlMs: config.listCacheTtlMs,
    stderrSink: createStderrSink(infra),
    stderrLogger: createStderrLogger(infra),
    metrics: infra.metrics,
    tracer: infra.tracer,
    logger,
  });

  const endpointCache = new EndpointCache({
    onCompile: (seconds) => infra.metrics.configCompileDuration.record(seconds),
  });

  const downstream = createDownstream({
    config: {
      publicUrl: config.publicUrl,
      authorizationServers: [config.urls.issuer],
      serverVersion: SERVER_VERSION,
      orgDisplayName: settings.get().org.displayName,
      legacyMaxSessionsPerPrincipal: config.legacyMaxSessionsPerPrincipal,
      listPageSize: config.listPageSize,
      captureContent: config.otelCaptureContent,
      allowedOrigins: [new URL(config.publicUrl).origin, ...(infra.options.extraCorsOrigins ?? [])],
      ...(infra.options.keepAliveMs === undefined
        ? {}
        : { keepAliveMs: infra.options.keepAliveMs }),
    },
    upstream: upstreamPortFrom(runtime, { installations, credentials }),
    installations,
    items: runtime.lists,
    reads: runtime.lists.reads,
    workers: runtime.registry,
    forwarder: runtime.rpcClient,
    redis: infra.redis as never,
    verifier: auth.verifier,
    endpointData,
    policy: { current: () => deps.policy.current() },
    endpointCache,
    profiles,
    ...(deps.catalogInstall ? { catalogInstall: deps.catalogInstall } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    stateKeyring: auth.stateKeyring,
    limiter: deps.limits.limiter,
    limitRules: deps.limits.rules,
    guards: deps.guards.pipeline,
    guardProfiles: deps.guards.profiles,
    callLog,
    metrics: infra.metrics,
    tracer: infra.tracer,
    logger,
  });
  // The owner side delivers a legacy client's response to the worker holding its SSE stream (6.5).
  (
    runtime.service as { sessionResponse?: (id: string, message: unknown) => Promise<void> }
  ).sessionResponse = (sessionId, message) => downstream.deliverSessionResponse(sessionId, message);

  auth.setInstanceStopper(async (principalId) => {
    for (const row of await infra.repos.instances.listRunning(principalId)) {
      await runtime.instances.stopAnywhere(row.id);
    }
  });

  let rpc: { port: number; close(): Promise<void> } | undefined;
  const unsubscribe: Array<() => void> = [];
  let stopped = false;

  return {
    runtime,
    downstream,
    driver: sandbox.driver,
    driverState: sandbox.driverState,
    registerRoutes: (app) => downstream.registerRoutes(app),
    async start() {
      rpc = await runtime.rpcServer.listen(
        config.internalPort,
        infra.options.listenHost ?? '0.0.0.0',
      );
      await sandbox.start();
      await runtime.start();
      await downstream.start();
      unsubscribe.push(
        settings.watch(),
        watchConfig(infra, (event) => {
          // 4.3: `{scope, id}` drops the endpoints that depend on it, a bare topic drops everything. The row version
          // is deliberately not passed: it counts one scope, the cache key counts the org scope.
          if (event.scope && event.id)
            endpointCache.invalidate({ scope: event.scope, id: event.id });
          else endpointCache.clear();
        }),
        installations.watch(),
        endpointData.watch(),
        ...[deps.policy.watch, deps.guards.watch, deps.limits.watch]
          .map((watch) => watch?.())
          .filter((stop): stop is () => void => typeof stop === 'function'),
      );
      infra.logger.info(
        { address, internalPort: rpc.port, driver: (await sandbox.driverState()).name },
        'worker started',
      );
    },
    async stop(graceMs = 25_000) {
      if (stopped) return;
      stopped = true;
      for (const stop of unsubscribe.splice(0)) stop();
      await runtime.registry.markDraining().catch(() => undefined);
      await downstream.shutdown({ graceMs }).catch(() => undefined);
      await runtime.stop(graceMs).catch(() => undefined);
      await runtime.registry.stop().catch(() => undefined);
      await rpc?.close().catch(() => undefined);
      await sandbox.stop();
      await callLog.close().catch(() => undefined);
    },
    internalRpcPort: () => rpc?.port ?? 0,
    internalRpcListening: () => rpc !== undefined && !stopped,
  };
};

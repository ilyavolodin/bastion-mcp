import {
  type BastionError,
  CONTINUABLE_METHODS,
  type Keyring,
  MS,
  newId,
  type RequestStateBinding,
  UpstreamAuthRequiredError,
  UpstreamUnavailableError,
  unwrapRequestState,
  wrapRequestState,
} from '@bastion-mcp/core';
import { type BastionMetrics, upstreamMcpSpan } from '@bastion-mcp/telemetry';
import { SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import type { EraCache } from '../connectors/era-cache';
import { activeTraceCarrier, timeoutFor } from '../connectors/identity';
import type { OpOptions, UpstreamSession } from '../connectors/types';
import { ContinuationLostError, type ErrorContext, mapUpstreamError } from '../errors';
import { clientSupports } from '../input-required/helpers';
import { lookupContinuation } from '../input-required/registry';
import type { EnsureArgs, InstanceManager, LiveInstance } from '../instances/manager';
import { SPAN_ATTRS } from '../instances/telemetry';
import type { LeaseManager } from '../ownership/lease';
import type { WorkerRegistry } from '../ownership/registry';
import { gracefulShutdown, InflightTracker } from '../ownership/shutdown';
import {
  type CallPrincipal,
  type Clock,
  type ConnectUrlBuilder,
  type InstallationRegistry,
  type Logger,
  noopLogger,
  type RedisLike,
  type ResolvedCredential,
  type ResolvedInstallation,
  systemClock,
  type UpstreamCredentialProvider,
} from '../ports';
import { ForwardConnectError, type InternalRpcClient } from '../rpc/client';
import type { OpBody, OpEvent, ResumeBody, SubscriptionBody } from '../rpc/protocol';
import type { InternalRpcHandlers } from '../rpc/server';
import { isTaskMethod, rewriteTaskId, unwrapTaskId, wrapTaskResult } from '../tasks/wrap';
import {
  type JsonObject,
  type SessionOutcome,
  toWireContext,
  type UpstreamCallContext,
  type UpstreamNotification,
  type UpstreamOutcome,
  type WireContext,
} from '../types';
import type { RemotePool } from './pool';

const CONNECT_RETRY_DELAY_MS = 250;

export type SessionInfo = {
  installation: ResolvedInstallation;
  session: UpstreamSession;
  credentialHash: string;
  principalId: string;
  /** Present for owned instances (sandbox, legacy remote). */
  instanceId?: string | undefined;
};

export type UpstreamServiceDeps = {
  redis: RedisLike;
  registry: WorkerRegistry;
  leases: LeaseManager;
  instances: InstanceManager;
  pool: RemotePool;
  eraCache: EraCache;
  rpc: InternalRpcClient;
  installations: InstallationRegistry;
  credentials: UpstreamCredentialProvider;
  connectUrls: ConnectUrlBuilder;
  /** The `state` keyring of section 22.3 (requestState and task ids). */
  stateKeyring: Keyring;
  metrics?: Pick<BastionMetrics, 'mcpClientOperationDuration'> | undefined;
  tracer?: Tracer;
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The upstream half of the operation layer (6.2): runs one operation against an installation's upstream, wherever
 * its connection lives. Modern remotes are called directly from any worker; sandboxes and legacy remote sessions
 * belong to an owner worker and other replicas forward to it (21.2).
 */
export class UpstreamService implements InternalRpcHandlers {
  readonly inflight = new InflightTracker();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sessionListeners: ((info: SessionInfo) => void)[] = [];
  private readonly seenSessions = new WeakSet<UpstreamSession>();
  private readonly metaByKey = new Map<
    string,
    { instructions?: string | undefined; serverInfo?: UpstreamSession['serverInfo'] }
  >();

  constructor(private readonly deps: UpstreamServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.tracer = deps.tracer ?? trace.getTracer('bastion-mcp-upstream');
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Called once for every new pooled or owned session (the listen module attaches notification handlers here). */
  onSession(listener: (info: SessionInfo) => void): void {
    this.sessionListeners.push(listener);
  }

  private announce(info: SessionInfo): void {
    this.metaByKey.set(`${info.installation.installationId}:${info.credentialHash}`, {
      instructions: info.session.instructions,
      serverInfo: info.session.serverInfo,
    });
    if (this.seenSessions.has(info.session)) return;
    this.seenSessions.add(info.session);
    for (const listener of this.sessionListeners) {
      try {
        listener(info);
      } catch (error) {
        this.logger.warn('session listener threw', { error: String(error) });
      }
    }
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now() / MS.SECOND);
  }

  // --- public API for the downstream operation layer --------------------------------------------------------------

  /**
   * Runs `method` on the installation's upstream. Returns the OpOutcome shape of 6.2: `complete`, `input_required`
   * (with `inputRequests` and a Bastion-wrapped `requestState`) or `task` (with a wrapped task id). A retry carries
   * `inputResponses` and the wrapped `requestState` in `params`.
   */
  async execute(request: {
    installationId: string;
    method: string;
    params: JsonObject;
    ctx: UpstreamCallContext;
  }): Promise<UpstreamOutcome> {
    const { ctx } = request;
    return this.guarded(
      request.installationId,
      ctx,
      request.method,
      async (installation) => {
        const credential = await this.credentialFor(ctx.principal, installation);
        return this.dispatch(installation, credential, request.method, request.params, ctx);
      },
      (mapped, installation) =>
        mapped instanceof UpstreamAuthRequiredError
          ? this.authElicitation(installation, mapped, request, ctx)
          : undefined,
    );
  }

  /**
   * The envelope of every operation entry point: counted as in flight (graceful shutdown), the installation resolved,
   * and any failure mapped to its `BastionError`. `recover` may turn a mapped error into an outcome instead.
   */
  private guarded<T>(
    installationId: string,
    ctx: Pick<UpstreamCallContext, 'principal'>,
    method: string,
    body: (installation: ResolvedInstallation) => Promise<T>,
    recover?: (mapped: BastionError, installation: ResolvedInstallation) => T | undefined,
  ): Promise<T> {
    return this.inflight.track(async () => {
      let installation: ResolvedInstallation | undefined;
      try {
        installation = await this.requireInstallation(installationId);
        return await body(installation);
      } catch (error) {
        const mapped = await this.mapError(error, installation, installationId, ctx, method);
        const recovered = installation ? recover?.(mapped, installation) : undefined;
        if (recovered !== undefined) return recovered;
        throw mapped;
      }
    });
  }

  /**
   * A missing upstream credential during a call (6.5): when the client declared `elicitation.url` the call returns
   * `input_required` with a URL-mode elicitation pointing at the connect page; otherwise the caller gets the `-32015`
   * error with `data.connectUrl`. Lists never come through here: they skip the installation (7.5).
   */
  private authElicitation(
    installation: ResolvedInstallation,
    error: UpstreamAuthRequiredError,
    request: { method: string; params: JsonObject },
    ctx: UpstreamCallContext,
  ): UpstreamOutcome | undefined {
    if (
      !CONTINUABLE_METHODS.has(request.method) ||
      !clientSupports(ctx.clientCapabilities, 'elicitation', { mode: 'url' })
    ) {
      return undefined;
    }
    const binding = this.binding(installation, request.method, request.params, ctx);
    return {
      kind: 'input_required',
      inputRequests: {
        auth: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: `Connect ${installation.slug} to continue.`,
            url: error.data.connectUrl,
            elicitationId: newId(),
          },
        },
      },
      requestState: wrapRequestState(this.deps.stateKeyring, binding, { now: this.nowSeconds() }),
    };
  }

  /** The retry entry point (6.5): `inputResponses` plus the wrapped `requestState` from the previous `input_required`. */
  retry(request: {
    installationId: string;
    method: string;
    params: JsonObject;
    inputResponses: Record<string, unknown>;
    requestState: string;
    ctx: UpstreamCallContext;
  }): Promise<UpstreamOutcome> {
    return this.execute({
      installationId: request.installationId,
      method: request.method,
      params: {
        ...request.params,
        inputResponses: request.inputResponses,
        requestState: request.requestState,
      },
      ctx: request.ctx,
    });
  }

  /** `tasks/get`, `tasks/update` and `tasks/cancel` routed by the wrapped task id (6.8). */
  async executeTask(request: {
    method: string;
    params: JsonObject;
    ctx: UpstreamCallContext;
  }): Promise<UpstreamOutcome> {
    if (!isTaskMethod(request.method)) throw new Error(`${request.method} is not a task method`);
    const wrappedId = String(request.params.taskId ?? '');
    const payload = unwrapTaskId(
      this.deps.stateKeyring,
      wrappedId,
      request.ctx.principal.userId,
      this.nowSeconds(),
    );
    const outcome = await this.execute({
      installationId: payload.i,
      method: request.method,
      params: { ...request.params, taskId: payload.upstreamTaskId },
      ctx: { ...request.ctx, installationId: payload.i },
    });
    if (outcome.kind === 'complete') {
      return { kind: 'complete', result: rewriteTaskId(outcome.result, wrappedId) };
    }
    return outcome;
  }

  private async requireInstallation(installationId: string): Promise<ResolvedInstallation> {
    const installation = await this.deps.installations.get(installationId);
    if (!installation) {
      throw new UpstreamUnavailableError('the installation does not exist', {
        installation: installationId,
      });
    }
    return installation;
  }

  private credentialFor(
    principal: CallPrincipal,
    installation: ResolvedInstallation,
  ): Promise<ResolvedCredential> {
    return this.deps.credentials.resolve(principal, installation, installation.spec);
  }

  mapError(
    error: unknown,
    installation: ResolvedInstallation | undefined,
    installationId: string,
    ctx: Pick<UpstreamCallContext, 'principal'>,
    method = 'tools/call',
  ): Promise<BastionError> {
    // The timeout that applied to this call (6.4), reported in the -32017 data.
    const timeoutMs = timeoutFor(method, installation?.spec.timeouts);
    const errorContext: ErrorContext = {
      installation: installation?.slug ?? installationId,
      timeoutMs,
      connectUrl: () => this.deps.connectUrls.connectUrl(ctx.principal, installationId),
    };
    return mapUpstreamError(error, errorContext);
  }

  // --- routing ---------------------------------------------------------------------------------------------------------

  private async dispatch(
    installation: ResolvedInstallation,
    credential: ResolvedCredential,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
  ): Promise<UpstreamOutcome> {
    const signal = ctx.signal ?? new AbortController().signal;
    const spec = installation.spec;
    // Continuation retries go straight to the owner recorded in the state (6.5).
    const prepared = this.prepareRetry(installation, method, params, ctx);
    if (prepared?.continuation) {
      return this.resumeContinuation(
        installation,
        prepared.continuation.id,
        prepared.inputResponses,
        ctx,
        prepared.binding,
      );
    }
    const effectiveParams = prepared?.params ?? params;
    const binding = prepared?.binding ?? this.binding(installation, method, effectiveParams, ctx);

    if (spec.type === 'remote' && spec.transport === 'streamable-http') {
      const pooled = await this.deps.pool.get(installation, ctx.principal, credential, signal);
      if (pooled.era === 'modern') {
        this.announce({
          installation,
          session: pooled.session,
          credentialHash: credential.credentialHash,
          principalId: ctx.principal.userId,
        });
        return this.runOnSession(
          pooled.session,
          installation,
          method,
          effectiveParams,
          ctx,
          binding,
        );
      }
    }
    return this.dispatchOwned(
      installation,
      credential,
      method,
      effectiveParams,
      ctx,
      binding,
      false,
    );
  }

  /** Sandboxes and legacy remote sessions: find or become the owner, else forward (21.2). */
  private async dispatchOwned(
    installation: ResolvedInstallation,
    credential: ResolvedCredential,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
    binding: RequestStateBinding,
    isRetry: boolean,
  ): Promise<UpstreamOutcome> {
    const record = await this.deps.instances.instanceFor(installation);
    const args: EnsureArgs = {
      record,
      installation,
      principal: ctx.principal,
      credential,
      signal: ctx.signal ?? new AbortController().signal,
    };
    const ensured = await this.deps.instances.ensure(args);
    if (ensured.kind === 'local') {
      return this.runOnLive(ensured.live, installation, method, params, ctx, binding);
    }
    try {
      const outcome = await this.deps.rpc.forwardOp(
        ensured.address,
        record.id,
        { method, params, ctx: toWireContext(ctx) },
        { signal: ctx.signal, onNotification: ctx.emit },
      );
      return outcome;
    } catch (error) {
      if (!(error instanceof ForwardConnectError) || isRetry) {
        if (error instanceof ForwardConnectError) {
          throw new UpstreamUnavailableError('the worker owning this server is unreachable', {
            installation: installation.slug,
          });
        }
        throw error;
      }
      // The connection failed: wait 250 ms, re-read the lease and retry once; a dead owner is taken over (21.2).
      await this.sleep(CONNECT_RETRY_DELAY_MS);
      return this.dispatchOwned(installation, credential, method, params, ctx, binding, true);
    }
  }

  private runOnLive(
    live: LiveInstance,
    installation: ResolvedInstallation,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
    binding: RequestStateBinding,
  ): Promise<UpstreamOutcome> {
    this.announce({
      installation,
      session: live.session,
      credentialHash: live.credentialHash,
      principalId: live.principalId,
      instanceId: live.id,
    });
    return this.deps.instances.run(live, (session) =>
      this.runOnSession(session, installation, method, params, ctx, binding),
    );
  }

  // --- the operation itself ------------------------------------------------------------------------------------------

  private async runOnSession(
    session: UpstreamSession,
    installation: ResolvedInstallation,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
    binding: RequestStateBinding,
  ): Promise<UpstreamOutcome> {
    const started = performance.now();
    const span = upstreamMcpSpan({
      method,
      toolName: method === 'tools/call' ? (params.name as string | undefined) : undefined,
      promptName: method === 'prompts/get' ? (params.name as string | undefined) : undefined,
      resourceUri: method.startsWith('resources/') ? (params.uri as string | undefined) : undefined,
      principalType: ctx.principal.type ?? 'user',
      installationId: installation.installationId,
      installationSlug: installation.slug,
      catalogEntry: installation.catalogEntryName,
      catalogVersion: installation.catalogVersionId,
      eraUpstream: session.era,
      eraDownstream: ctx.era,
      protocolVersion: session.protocolVersion,
      networkTransport: installation.spec.type === 'package' ? 'pipe' : 'tcp',
    });
    let errorType: string | undefined;
    try {
      return await this.tracer.startActiveSpan(
        span.name,
        { kind: SpanKind.CLIENT, attributes: span.attributes },
        async (otelSpan) => {
          try {
            // The upstream sees the context of this CLIENT span (6.4); without a tracer the downstream's carries over.
            const trace = { ...ctx.trace, ...activeTraceCarrier() };
            const options: OpOptions = { ctx: { ...ctx, trace } };
            const outcome = await session.request(method, params, options);
            return this.wrap(outcome, installation, binding, ctx);
          } catch (error) {
            errorType = error instanceof Error ? error.name : 'error';
            otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
            throw error;
          } finally {
            otelSpan.end();
          }
        },
      );
    } finally {
      this.deps.metrics?.mcpClientOperationDuration.record((performance.now() - started) / 1000, {
        'mcp.method.name': method,
        ...(method === 'tools/call' && typeof params.name === 'string'
          ? { 'gen_ai.tool.name': params.name }
          : {}),
        ...(errorType === undefined ? {} : { 'error.type': errorType }),
        [SPAN_ATTRS.catalogEntry]: installation.catalogEntryName,
      });
    }
  }

  /** Wraps `requestState` and task ids so nothing upstream-private reaches the client unsealed (6.5, 6.8). */
  private wrap(
    outcome: SessionOutcome,
    installation: ResolvedInstallation,
    binding: RequestStateBinding,
    ctx: UpstreamCallContext,
  ): UpstreamOutcome {
    switch (outcome.kind) {
      case 'complete':
        return outcome;
      case 'task':
        return {
          kind: 'task',
          task: wrapTaskResult(this.deps.stateKeyring, outcome.task, {
            principalId: ctx.principal.userId,
            installationId: installation.installationId,
            nowSeconds: this.nowSeconds(),
          }),
        };
      case 'input_required':
        return {
          kind: 'input_required',
          ...(outcome.inputRequests ? { inputRequests: outcome.inputRequests } : {}),
          requestState: wrapRequestState(this.deps.stateKeyring, binding, {
            now: this.nowSeconds(),
            ...(outcome.upstreamState === undefined
              ? {}
              : { upstreamState: outcome.upstreamState }),
            ...(outcome.continuationId === undefined
              ? {}
              : {
                  continuationId: outcome.continuationId,
                  ownerWorkerId: this.deps.registry.workerId,
                }),
          }),
        };
    }
  }

  // --- requestState and continuations (6.5) ------------------------------------------------------------------------

  private binding(
    installation: ResolvedInstallation,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
  ): RequestStateBinding {
    const isRead = method === 'resources/read';
    return {
      principalId: ctx.principal.userId,
      endpointId: ctx.endpointId ?? '',
      installationId: installation.installationId,
      method,
      name: ctx.downstreamName ?? String(params.name ?? params.uri ?? ''),
      args: isRead ? (params.uri ?? '') : (params.arguments ?? {}),
    };
  }

  /**
   * On a retry: decrypt the wrapped state, reject mismatches with `-32602` (6.5), and either route to the
   * continuation owner (legacy upstream) or forward the upstream's own state unchanged (modern upstream).
   */
  private prepareRetry(
    installation: ResolvedInstallation,
    method: string,
    params: JsonObject,
    ctx: UpstreamCallContext,
  ):
    | {
        params: JsonObject;
        binding: RequestStateBinding;
        continuation?: { id: string; owner?: string | undefined };
        inputResponses: Record<string, unknown>;
      }
    | undefined {
    if (!CONTINUABLE_METHODS.has(method) || params.requestState === undefined) return undefined;
    const binding = this.binding(installation, method, params, ctx);
    const state = unwrapRequestState(this.deps.stateKeyring, String(params.requestState), binding, {
      now: this.nowSeconds(),
    });
    const inputResponses = (params.inputResponses ?? {}) as Record<string, unknown>;
    if (state.continuationId !== undefined) {
      return {
        params,
        binding,
        continuation: { id: state.continuationId, owner: state.ownerWorkerId },
        inputResponses,
      };
    }
    const forwarded: JsonObject = { ...params };
    if (state.upstreamState === undefined) delete forwarded.requestState;
    else forwarded.requestState = state.upstreamState;
    return { params: forwarded, binding, inputResponses };
  }

  /**
   * Delivers `inputResponses` to the continuation's owner (this worker or another, over internal RPC) and returns the
   * outcome of the resumed upstream call: complete, or more server requests on the same continuation (6.5).
   */
  async resumeContinuation(
    installation: ResolvedInstallation,
    continuationId: string,
    inputResponses: Record<string, unknown>,
    ctx: UpstreamCallContext,
    binding: RequestStateBinding,
  ): Promise<UpstreamOutcome> {
    const record = await lookupContinuation(this.deps.redis, continuationId);
    if (!record) throw new ContinuationLostError(installation.slug);
    if (record.workerId === this.deps.registry.workerId) {
      const outcome = await this.resumeLocal(
        record.instanceId,
        continuationId,
        inputResponses,
        ctx,
        installation,
      );
      return this.wrap(outcome, installation, binding, ctx);
    }
    const worker = await this.deps.registry.lookup(record.workerId);
    if (!worker) throw new ContinuationLostError(installation.slug);
    try {
      const outcome = await this.deps.rpc.forwardResume(
        worker.address,
        continuationId,
        { inputResponses, ctx: toWireContext(ctx) },
        { signal: ctx.signal, onNotification: ctx.emit },
      );
      return this.rewrap(outcome, binding);
    } catch (error) {
      if (error instanceof ForwardConnectError)
        throw new ContinuationLostError(installation.slug, error);
      throw error;
    }
  }

  /** The owner already wrapped the state with its own binding; the retry keeps the caller's. */
  private rewrap(outcome: UpstreamOutcome, binding: RequestStateBinding): UpstreamOutcome {
    if (outcome.kind !== 'input_required') return outcome;
    const state = unwrapRequestState(this.deps.stateKeyring, outcome.requestState, binding, {
      now: this.nowSeconds(),
    });
    return {
      ...outcome,
      requestState: wrapRequestState(this.deps.stateKeyring, binding, {
        now: this.nowSeconds(),
        ...(state.upstreamState === undefined ? {} : { upstreamState: state.upstreamState }),
        ...(state.continuationId === undefined ? {} : { continuationId: state.continuationId }),
        ...(state.ownerWorkerId === undefined ? {} : { ownerWorkerId: state.ownerWorkerId }),
      }),
    };
  }

  private async resumeLocal(
    instanceId: string,
    continuationId: string,
    inputResponses: Record<string, unknown>,
    ctx: UpstreamCallContext,
    installation: ResolvedInstallation,
  ): Promise<SessionOutcome> {
    const live = this.deps.instances.get(instanceId);
    if (!live?.session.hasContinuation(continuationId)) {
      throw new ContinuationLostError(installation.slug);
    }
    return this.deps.instances.run(live, (session) =>
      session.resumeContinuation(continuationId, inputResponses, { ctx }),
    );
  }

  // --- internal RPC handlers (the owner side, 21.2) ----------------------------------------------------------------

  private localContext(
    wire: WireContext,
    emit: (event: OpEvent) => void,
    signal: AbortSignal,
  ): UpstreamCallContext {
    return {
      ...wire,
      signal,
      emit: (n: UpstreamNotification) =>
        emit({ type: 'notification', method: n.method, ...(n.params ? { params: n.params } : {}) }),
    };
  }

  async op(
    instanceId: string,
    body: OpBody,
    emit: (event: OpEvent) => void,
    signal: AbortSignal,
  ): Promise<UpstreamOutcome> {
    const ctx = this.localContext(body.ctx, emit, signal);
    return this.guarded(body.ctx.installationId, ctx, body.method, async (installation) => {
      const credential = await this.credentialFor(ctx.principal, installation);
      const record = await this.deps.instances.instanceFor(installation);
      const target = record.id === instanceId ? record : { ...record, id: instanceId };
      const binding = this.binding(installation, body.method, body.params, ctx);
      const ensured = await this.deps.instances.ensure({
        record: target,
        installation,
        principal: ctx.principal,
        credential,
        signal,
      });
      if (ensured.kind !== 'local') {
        // Ownership moved while the request was in flight: the caller retries (no forwarding loops).
        throw new UpstreamUnavailableError('the server moved to another worker; retry', {
          installation: installation.slug,
        });
      }
      return this.runOnLive(ensured.live, installation, body.method, body.params, ctx, binding);
    });
  }

  async resume(
    continuationId: string,
    body: ResumeBody,
    emit: (event: OpEvent) => void,
    signal: AbortSignal,
  ): Promise<UpstreamOutcome> {
    const ctx = this.localContext(body.ctx, emit, signal);
    return this.guarded(body.ctx.installationId, ctx, 'tools/call', async (installation) => {
      const record = await lookupContinuation(this.deps.redis, continuationId);
      if (!record || record.workerId !== this.deps.registry.workerId) {
        throw new ContinuationLostError(installation.slug);
      }
      const outcome = await this.resumeLocal(
        record.instanceId,
        continuationId,
        body.inputResponses,
        ctx,
        installation,
      );
      return this.wrap(
        outcome,
        installation,
        this.binding(installation, 'tools/call', {}, ctx),
        ctx,
      );
    });
  }

  /** Subscription routing lives in the listen module; the service only exposes the hook. */
  subscriptionHandler: ((instanceId: string, body: SubscriptionBody) => Promise<void>) | undefined;

  async subscriptions(instanceId: string, body: SubscriptionBody): Promise<void> {
    if (!this.subscriptionHandler) {
      throw new UpstreamUnavailableError('subscriptions are not enabled on this worker', {
        installation: body.ctx.installationId,
      });
    }
    await this.subscriptionHandler(instanceId, body);
  }

  // --- helpers for other modules ------------------------------------------------------------------------------------

  /** `instructions` and `serverInfo` the upstream sent at its handshake (7.6), as last seen by this worker. */
  upstreamMeta(
    installation: ResolvedInstallation,
    credential: ResolvedCredential,
  ): { instructions?: string | undefined; serverInfo?: UpstreamSession['serverInfo'] } {
    return this.metaByKey.get(`${installation.installationId}:${credential.credentialHash}`) ?? {};
  }

  /** The pooled session of a modern remote (for `subscriptions/listen`, 6.6); undefined for owned or legacy upstreams. */
  async pooledSession(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<UpstreamSession | undefined> {
    if (installation.spec.type !== 'remote' || installation.spec.transport !== 'streamable-http')
      return undefined;
    const pooled = await this.deps.pool.get(installation, principal, credential, signal);
    if (pooled.era !== 'modern') return undefined;
    this.announce({
      installation,
      session: pooled.session,
      credentialHash: credential.credentialHash,
      principalId: principal.userId,
    });
    return pooled.session;
  }

  /** Becomes (or finds) the owner of an installation's stateful instance (21.2). */
  async acquireOwned(
    installation: ResolvedInstallation,
    principal: CallPrincipal,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<
    { instanceId: string } & (
      | { kind: 'local'; live: LiveInstance }
      | { kind: 'forward'; workerId: string; address: string }
    )
  > {
    const record = await this.deps.instances.instanceFor(installation);
    const ensured = await this.deps.instances.ensure({
      record,
      installation,
      principal,
      credential,
      signal,
    });
    if (ensured.kind === 'local') {
      this.announce({
        installation,
        session: ensured.live.session,
        credentialHash: ensured.live.credentialHash,
        principalId: ensured.live.principalId,
        instanceId: ensured.live.id,
      });
    }
    return { instanceId: record.id, ...ensured };
  }

  /** Finds out where an installation's owned instance lives, without starting anything. */
  async locateInstance(
    installation: ResolvedInstallation,
  ): Promise<{ instanceId: string; owner: 'local' | 'remote' | 'none' }> {
    const record = await this.deps.instances.getRecord(installation);
    if (!record) return { instanceId: '', owner: 'none' };
    const located = await this.deps.leases.locate(record.id);
    if (located.kind === 'vacant') return { instanceId: record.id, owner: 'none' };
    return { instanceId: record.id, owner: located.kind === 'local' ? 'local' : 'remote' };
  }

  /** Graceful shutdown (21.2): finish in-flight work, close connections (sandboxes keep running), drop leases. */
  async shutdown(graceMs?: number): Promise<{ drained: boolean }> {
    return gracefulShutdown({
      registry: this.deps.registry,
      leases: this.deps.leases,
      inflight: this.inflight,
      closeConnections: async () => {
        await this.deps.pool.closeAll();
        await this.deps.instances.closeConnections();
      },
      ...(graceMs === undefined ? {} : { graceMs }),
      logger: this.logger,
    });
  }
}

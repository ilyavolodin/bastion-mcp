import {
  type Clock,
  CONTINUABLE_METHODS,
  type Era,
  isRecord,
  JSONRPC_CODES,
  newId,
  systemClock,
  TIMEOUTS_MS,
} from '@bastion-mcp/core';
import {
  type Client,
  isInputRequiredResult,
  type RequestOptions,
  type StandardSchemaV1,
  type Transport,
} from '@modelcontextprotocol/client';
import { ContinuationLostError } from '../errors';
import { LegacyCallScope, type ScopeEvent } from '../input-required/call-scope';
import {
  answerMissingCapability,
  budgetedTimeout,
  type ServerRequestKind,
} from '../input-required/helpers';
import type { ContinuationRegistry } from '../input-required/registry';
import { type Logger, noopLogger, type ResolvedInstallation } from '../ports';
import { extensionAllowed, filterExtensions } from '../tasks/extensions';
import type {
  ClientCapabilitiesLike,
  JsonObject,
  SessionOutcome,
  UpstreamNotification,
} from '../types';
import {
  buildRequestMeta,
  declaredCapabilities,
  intersectCapabilities,
  timeoutFor,
} from './identity';
import { runWithTrace } from './trace';
import type {
  CloseInfo,
  ListenFilter,
  OpOptions,
  UpstreamSession,
  UpstreamSubscription,
} from './types';

/** Accepts any object result so Bastion forwards upstream results byte for byte (6.9). */
export const RAW_RESULT: StandardSchemaV1<unknown, JsonObject> = {
  '~standard': {
    version: 1,
    vendor: 'bastion',
    validate: (value) =>
      isRecord(value)
        ? { value: value as JsonObject }
        : { issues: [{ message: 'result must be an object' }] },
  },
};

const MODERN_ONLY_EXTENSIONS_KEY = 'extensions';

export type SdkSessionOptions = {
  client: Client;
  transport: Transport;
  installation: ResolvedInstallation;
  era: Era;
  /** Falls back to these when the SDK has no handshake data (a resumed legacy session). */
  fallback?: {
    serverCapabilities?: JsonObject | undefined;
    protocolVersion?: string | undefined;
  };
  continuations?: ContinuationRegistry | undefined;
  logger?: Logger;
  clock?: Clock;
  /** Abort reason when a response cap was exceeded (6.9). */
  capViolation?: () => Error | undefined;
  /** Close details of the transport (sandbox exit frame, WebSocket close code). */
  describeClose?: () => CloseInfo;
};

type InFlight = { abort: AbortController; emit?: ((n: UpstreamNotification) => void) | undefined };

/** Operations over an SDK `Client`: modern or legacy upstream, HTTP, SSE or sandbox stdio. */
export class SdkUpstreamSession implements UpstreamSession {
  readonly era: Era;
  private readonly client: Client;
  private readonly transport: Transport;
  private readonly installation: ResolvedInstallation;
  private readonly options: SdkSessionOptions;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly sinks = new Set<(n: UpstreamNotification) => void>();
  private readonly closeHandlers: ((info: CloseInfo) => void)[] = [];
  private readonly inflight = new Set<InFlight>();
  /** Legacy calls that can raise server requests, oldest first. */
  private readonly scopes = new Set<LegacyCallScope>();
  private _closed = false;
  closeInfo: CloseInfo = {};

  constructor(options: SdkSessionOptions) {
    this.options = options;
    this.client = options.client;
    this.transport = options.transport;
    this.installation = options.installation;
    this.era = options.era;
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? systemClock;
    this.wireClient();
  }

  // --- uniform surface ----------------------------------------------------------------------------------------

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion() ?? this.options.fallback?.protocolVersion;
  }
  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
  get serverCapabilities(): JsonObject {
    return (
      (this.client.getServerCapabilities() as JsonObject | undefined) ??
      this.options.fallback?.serverCapabilities ??
      {}
    );
  }
  get serverInfo(): UpstreamSession['serverInfo'] {
    return this.client.getServerVersion() as UpstreamSession['serverInfo'];
  }
  get instructions(): string | undefined {
    return this.client.getInstructions();
  }
  get closed(): boolean {
    return this._closed;
  }

  callTool(params: JsonObject, options: OpOptions) {
    return this.request('tools/call', params, options);
  }
  getPrompt(params: JsonObject, options: OpOptions) {
    return this.request('prompts/get', params, options);
  }
  readResource(params: JsonObject, options: OpOptions) {
    return this.request('resources/read', params, options);
  }
  complete(params: JsonObject, options: OpOptions) {
    return this.request('completion/complete', params, options);
  }
  listTools(params: JsonObject, options: OpOptions) {
    return this.completeResult('tools/list', params, options);
  }
  listPrompts(params: JsonObject, options: OpOptions) {
    return this.completeResult('prompts/list', params, options);
  }
  listResources(params: JsonObject, options: OpOptions) {
    return this.completeResult('resources/list', params, options);
  }
  listResourceTemplates(params: JsonObject, options: OpOptions) {
    return this.completeResult('resources/templates/list', params, options);
  }
  async subscribe(uri: string, options: OpOptions): Promise<void> {
    await this.request('resources/subscribe', { uri }, options);
  }
  async unsubscribe(uri: string, options: OpOptions): Promise<void> {
    await this.request('resources/unsubscribe', { uri }, options);
  }
  async ping(options: OpOptions): Promise<void> {
    await this.request('ping', {}, options);
  }

  private async completeResult(
    method: string,
    params: JsonObject,
    options: OpOptions,
  ): Promise<JsonObject> {
    const outcome = await this.request(method, params, options);
    if (outcome.kind !== 'complete') throw new Error(`${method} cannot need input`);
    return outcome.result as JsonObject;
  }

  onNotification(handler: (notification: UpstreamNotification) => void): () => void {
    this.sinks.add(handler);
    return () => this.sinks.delete(handler);
  }

  onClose(handler: (info: CloseInfo) => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    for (const scope of this.scopes) scope.dispose();
    this.scopes.clear();
    await this.options.continuations?.closeAll();
    await this.client.close().catch(() => undefined);
  }

  /** Aborts everything in flight (a response cap was exceeded, 6.9; or the lease was lost, 21.2). */
  abortAll(reason: Error): void {
    for (const call of this.inflight) call.abort.abort(reason);
    for (const scope of this.scopes) scope.abort.abort(reason);
  }

  // --- wiring ------------------------------------------------------------------------------------------------

  private wireClient(): void {
    const { client } = this;
    const handlers: [string, ServerRequestKind][] = [['elicitation/create', 'elicitation']];
    if (this.installation.enableSampling) handlers.push(['sampling/createMessage', 'sampling']);
    if (this.installation.enableRoots) handlers.push(['roots/list', 'roots']);
    for (const [method, kind] of handlers) {
      client.setRequestHandler(
        method as 'elicitation/create',
        ((request: { params?: unknown }) => this.routeServerRequest(kind, request.params)) as never,
      );
    }
    const forward = (method: string) => (notification: { params?: unknown }) => {
      this.dispatchNotification({
        method,
        ...(isRecord(notification.params) ? { params: notification.params } : {}),
      });
    };
    for (const method of [
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
      'notifications/resources/updated',
    ]) {
      client.setNotificationHandler(
        method as 'notifications/tools/list_changed',
        forward(method) as never,
      );
    }
    client.setNotificationHandler(
      'notifications/message' as 'notifications/message',
      ((n: { params?: unknown }) => {
        const note: UpstreamNotification = {
          method: 'notifications/message',
          ...(isRecord(n.params) ? { params: n.params } : {}),
        };
        const emitters = [...this.inflight].flatMap((call) => (call.emit ? [call.emit] : []));
        if (emitters.length === 0) this.dispatchNotification(note);
        for (const emit of emitters) emit(note);
      }) as never,
    );
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method.startsWith('notifications/progress')) return;
      this.dispatchNotification({
        method: notification.method,
        ...(isRecord(notification.params) ? { params: notification.params } : {}),
      });
    };
    client.onclose = () => {
      if (!this._closed) {
        this._closed = true;
        for (const scope of this.scopes) scope.dispose();
        this.scopes.clear();
      }
      const info = { ...this.closeInfo, ...(this.options.describeClose?.() ?? {}) };
      for (const handler of this.closeHandlers) handler(info);
    };
    client.onerror = (error) => {
      this.closeInfo = { ...this.closeInfo, error };
      this.logger.debug('upstream client error', { error: error.message });
    };
  }

  private dispatchNotification(notification: UpstreamNotification): void {
    for (const sink of this.sinks) {
      try {
        sink(notification);
      } catch (error) {
        this.logger.warn('notification sink threw', { error: String(error) });
      }
    }
  }

  /** A server-to-client request of a legacy upstream (6.5): attributed to the oldest call that is still running. */
  private routeServerRequest(kind: ServerRequestKind, params: unknown): Promise<unknown> {
    for (const scope of this.scopes) {
      if (!scope.done) return scope.handleServerRequest(kind, params);
    }
    try {
      return Promise.resolve(answerMissingCapability(kind, this.installation.roots));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // --- requests ------------------------------------------------------------------------------------------------

  private effectiveTimeout(method: string, options: OpOptions): number {
    const base = options.timeoutMs ?? timeoutFor(method, this.installation.spec.timeouts);
    return budgetedTimeout(base, options.ctx.deadlineAt, this.clock.now());
  }

  private sendParams(params: JsonObject, options: OpOptions): JsonObject {
    const { ctx } = options;
    let capabilities: ClientCapabilitiesLike | undefined;
    if (this.era === 'modern') {
      const declared = declaredCapabilities(this.installation);
      capabilities = intersectCapabilities(declared, ctx.clientCapabilities);
      const extensions = filterExtensions(
        (ctx.clientCapabilities as { extensions?: Record<string, unknown> })[
          MODERN_ONLY_EXTENSIONS_KEY
        ],
        this.installation.extensions,
        { singleInstallationEndpoint: ctx.singleInstallationEndpoint ?? false },
      );
      if (Object.keys(extensions).length > 0) {
        (capabilities as Record<string, unknown>)[MODERN_ONLY_EXTENSIONS_KEY] = extensions;
      }
    }
    const meta = buildRequestMeta(
      {
        principal: ctx.principal,
        trace: ctx.trace,
        logLevel: ctx.logLevel,
        capabilities,
      },
      isRecord(params._meta) ? params._meta : undefined,
    );
    return { ...params, _meta: meta };
  }

  private rawOptions(
    timeout: number,
    signal: AbortSignal,
    emit: ((n: UpstreamNotification) => void) | undefined,
    onProgress?: () => void,
  ): RequestOptions {
    return {
      timeout,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: TIMEOUTS_MS.maxOverride,
      signal,
      allowInputRequired: true,
      ...(emit || onProgress
        ? {
            onprogress: (progress) => {
              onProgress?.();
              emit?.({
                method: 'notifications/progress',
                params: {
                  progress: progress.progress,
                  ...(progress.total === undefined ? {} : { total: progress.total }),
                  ...(progress.message === undefined ? {} : { message: progress.message }),
                },
              });
            },
          }
        : {}),
    };
  }

  async request(method: string, params: JsonObject, options: OpOptions): Promise<SessionOutcome> {
    if (this._closed) throw new Error('upstream session is closed');
    if (method.startsWith('tasks/') || method === 'tools/call')
      this.assertExtensionUse(method, options);
    const timeout = this.effectiveTimeout(method, options);
    const sendParams = this.sendParams(params, options);
    if (this.era === 'legacy' && CONTINUABLE_METHODS.has(method)) {
      return this.requestContinuable(method, sendParams, timeout, options);
    }
    const abort = new AbortController();
    const unlink = linkSignal(options.ctx.signal, abort);
    const entry: InFlight = { abort, emit: options.ctx.emit };
    this.inflight.add(entry);
    try {
      const raw = await runWithTrace(options.ctx.trace, () =>
        this.client.request(
          { method, params: sendParams } as never,
          RAW_RESULT,
          this.rawOptions(timeout, abort.signal, options.ctx.emit),
        ),
      );
      return toOutcome(raw);
    } catch (error) {
      throw this.options.capViolation?.() ?? error;
    } finally {
      unlink();
      this.inflight.delete(entry);
    }
  }

  /** A blocked or unlisted extension must not be used even if the downstream asked for it (6.8). */
  private assertExtensionUse(method: string, options: OpOptions): void {
    if (!method.startsWith('tasks/')) return;
    const allowed = extensionAllowed(
      'io.modelcontextprotocol/tasks',
      this.installation.extensions,
      {
        singleInstallationEndpoint: options.ctx.singleInstallationEndpoint ?? false,
      },
    );
    if (!allowed)
      throw Object.assign(new Error('extension not allowed for this installation'), {
        code: JSONRPC_CODES.METHOD_NOT_FOUND,
      });
  }

  // --- legacy continuations (6.5) --------------------------------------------------------------------------------

  private async requestContinuable(
    method: string,
    sendParams: JsonObject,
    timeout: number,
    options: OpOptions,
  ): Promise<SessionOutcome> {
    const { ctx } = options;
    const scope = new LegacyCallScope({
      id: newId(),
      clientCapabilities: ctx.clientCapabilities,
      roots: this.installation.roots,
      clock: this.clock,
    });
    scope.emit = ctx.emit;
    this.scopes.add(scope);
    scope.onSettled(() => this.scopes.delete(scope));
    scope.bind(ctx.signal);
    scope.armTimeout(timeout);
    // The SDK timeout is only a backstop: the scope's own timer pauses while the user is being asked.
    const call = runWithTrace(ctx.trace, () =>
      this.client.request(
        { method, params: sendParams } as never,
        RAW_RESULT,
        this.rawOptions(
          TIMEOUTS_MS.maxOverride,
          scope.abort.signal,
          ctx.emit && ((n) => scope.emit?.(n)),
          () => scope.touch(),
        ),
      ),
    );
    scope.attach(call);
    return this.driveScope(scope);
  }

  private async driveScope(scope: LegacyCallScope): Promise<SessionOutcome> {
    let event: ScopeEvent;
    try {
      event = await scope.next();
    } catch (error) {
      throw this.options.capViolation?.() ?? error;
    }
    if (event.type === 'done') {
      scope.unbind();
      return toOutcome(event.result);
    }
    // The downstream request ends here; the upstream call keeps waiting without its signal.
    scope.unbind();
    await this.options.continuations?.publish(scope);
    return { kind: 'input_required', inputRequests: event.inputRequests, continuationId: scope.id };
  }

  hasContinuation(continuationId: string): boolean {
    return this.options.continuations?.get(continuationId) !== undefined;
  }

  async resumeContinuation(
    continuationId: string,
    inputResponses: Record<string, unknown>,
    options: OpOptions,
  ): Promise<SessionOutcome> {
    const scope = this.options.continuations?.get(continuationId);
    if (!scope || scope.done) {
      throw new ContinuationLostError(this.installation.slug);
    }
    this.options.continuations?.hold(continuationId);
    scope.emit = options.ctx.emit;
    scope.bind(options.ctx.signal);
    scope.resume(inputResponses, options.ctx.clientCapabilities);
    return this.driveScope(scope);
  }

  // --- modern listen ---------------------------------------------------------------------------------------------

  async listen(filter: ListenFilter, options: OpOptions): Promise<UpstreamSubscription> {
    const sub = await this.client.listen(filter, {
      ...(options.ctx.signal ? { signal: options.ctx.signal } : {}),
    });
    return { close: () => sub.close(), closed: sub.closed };
  }
}

const linkSignal = (signal: AbortSignal | undefined, abort: AbortController): (() => void) => {
  if (!signal) return () => undefined;
  const onAbort = (): void => abort.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
};

/** The OpOutcome shape (6.2) of a raw upstream result. */
export const toOutcome = (raw: unknown): SessionOutcome => {
  if (isInputRequiredResult(raw)) {
    const r = raw as {
      inputRequests?: Record<string, { method: string; params?: unknown }>;
      requestState?: string;
    };
    return {
      kind: 'input_required',
      inputRequests: r.inputRequests,
      upstreamState: r.requestState,
    };
  }
  if (isRecord(raw) && raw.resultType === 'task') return { kind: 'task', task: raw };
  return { kind: 'complete', result: raw };
};

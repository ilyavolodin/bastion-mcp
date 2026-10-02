/**
 * Bastion's own handler for the 2025-era Streamable HTTP transport (6.2), placed in front of the modern adapter. It
 * serves POST (requests, notifications, client responses), the standalone GET stream and DELETE, with sessions in
 * Redis so any replica serves any request of a session.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { PROTOCOL_VERSIONS, REDIS_CHANNELS, redisKeys, TTL } from '@bastion-mcp/core';
import { clientCapabilitiesSchema } from '@bastion-mcp/mcp-upstream';
import { type BastionMetrics, extractTraceContext } from '@bastion-mcp/telemetry';
import { InitializeRequestParamsSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import { type SpanContext, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { driveLegacyInput } from '../../bridge/legacy';
import {
  type Clock,
  type DownstreamRedis,
  type Logger,
  noopLogger,
  type SessionResponseForwarder,
  systemClock,
  type WorkerDirectory,
} from '../../ports';
import { InvalidRequestError, toRpcErrorBody } from '../../rpc';
import type { ClientCaps, JsonObject, OpContext } from '../../types';
import type {
  Exchange,
  LegacyAdapter,
  NotifyEvent,
  NotifyHubPort,
  NotifyKind,
  OpRunner,
} from '../contracts';
import { LegacySessionStore, newSessionId, type SessionRecord } from './sessions';
import { SseStream } from './stream';

export type LegacyAdapterDeps = {
  redis: DownstreamRedis;
  hub: NotifyHubPort;
  run: OpRunner;
  workers: WorkerDirectory;
  forwarder: SessionResponseForwarder;
  maxSessionsPerPrincipal: number;
  /** Configured roots of an installation, for the missing-roots answer (6.5). */
  roots: (installationId: string) => Promise<readonly string[]>;
  metrics?: Pick<BastionMetrics, 'streamsActive' | 'mcpServerSessionDuration'> | undefined;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  /** SSE comment interval on idle streams; default 25 s. */
  keepAliveMs?: number | undefined;
  sessionIdGenerator?: (() => string) | undefined;
  /** How long a server-to-client request waits for the client's answer; default 10 minutes. */
  pendingResponseTimeoutMs?: number | undefined;
};

const SSE_METHODS: ReadonlySet<string> = new Set(['tools/call', 'resources/read', 'prompts/get']);
const ALLOW = 'GET, POST, DELETE';
const NOTIFICATION_OF_KIND: Record<Exclude<NotifyKind, 'resource_updated'>, string> = {
  tools_list_changed: 'notifications/tools/list_changed',
  prompts_list_changed: 'notifications/prompts/list_changed',
  resources_list_changed: 'notifications/resources/list_changed',
};

const isRecord = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const channelMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('replace'), by: z.string() }),
  z.object({ type: z.literal('cancel'), requestId: z.union([z.string(), z.number()]) }),
  z.object({
    type: z.literal('notification'),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const rpcFailure = (id: unknown, error: unknown): JsonObject => ({
  jsonrpc: '2.0',
  id: typeof id === 'string' || typeof id === 'number' ? id : null,
  error: toRpcErrorBody(error),
});

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
};

const sendStatus = (
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end();
};

class LegacyHandler implements LegacyAdapter {
  private readonly store: LegacySessionStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly pending = new Map<string, (message: JsonObject) => void>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly streams = new Set<SseStream>();
  private readonly counts = { response: 0, legacy_get: 0 };
  private subscriber: ReturnType<DownstreamRedis['duplicate']> | undefined;
  private readonly channelHandlers = new Map<string, Set<(raw: string) => void>>();

  constructor(private readonly deps: LegacyAdapterDeps) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
    this.store = new LegacySessionStore(deps.redis, {
      maxPerPrincipal: deps.maxSessionsPerPrincipal,
      now: () => this.clock.now(),
    });
  }

  activeStreams(): number {
    return this.streams.size;
  }

  async shutdown(): Promise<void> {
    for (const s of [...this.streams]) s.end();
    for (const c of this.inflight.values()) c.abort();
    const sub = this.subscriber;
    this.subscriber = undefined;
    this.channelHandlers.clear();
    if (sub) await sub.quit().catch(() => undefined);
  }

  // --- entry ---------------------------------------------------------------------------------------------------------

  async handle(ex: Exchange): Promise<void> {
    try {
      switch (ex.req.method) {
        case 'POST':
          await this.post(ex);
          return;
        case 'GET':
          await this.get(ex);
          return;
        case 'DELETE':
          await this.del(ex);
          return;
        default:
          sendStatus(ex.res, 405, { allow: ALLOW });
      }
    } catch (error) {
      this.logger.error('legacy adapter failed', { error: String(error) });
      if (!ex.res.headersSent) sendJson(ex.res, 500, rpcFailure(null, error));
      else ex.res.end();
    }
  }

  // --- metrics -----------------------------------------------------------------------------------------------------

  private track(type: 'response' | 'legacy_get', stream: SseStream): void {
    this.streams.add(stream);
    this.counts[type] += 1;
    this.deps.metrics?.streamsActive.record(this.counts[type], { era: 'legacy', type });
    stream.onClose(() => {
      this.streams.delete(stream);
      this.counts[type] -= 1;
      this.deps.metrics?.streamsActive.record(this.counts[type], { era: 'legacy', type });
    });
  }

  // --- session channel (6.2, 6.6) --------------------------------------------------------------------------------------

  private async onChannel(sessionId: string, handler: (raw: string) => void): Promise<() => void> {
    const channel = REDIS_CHANNELS.session(sessionId);
    if (!this.subscriber) {
      const sub = this.deps.redis.duplicate();
      sub.on('message', (ch, message) => {
        for (const h of [...(this.channelHandlers.get(ch) ?? [])]) h(message);
      });
      this.subscriber = sub;
    }
    const set = this.channelHandlers.get(channel) ?? new Set();
    this.channelHandlers.set(channel, set);
    set.add(handler);
    if (set.size === 1) await this.subscriber.subscribe(channel);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.channelHandlers.delete(channel);
        void this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  // --- session lookup --------------------------------------------------------------------------------------------------

  /** Validates `Mcp-Session-Id`; answers the HTTP error itself and returns null when the request cannot proceed. */
  private async session(ex: Exchange): Promise<SessionRecord | null> {
    const id = first(ex.req.headers['mcp-session-id']);
    if (id === undefined || id === '') {
      sendJson(
        ex.res,
        400,
        rpcFailure(null, new InvalidRequestError('Mcp-Session-Id header required')),
      );
      return null;
    }
    const session = await this.store.get(id);
    if (
      !session ||
      session.principalId !== ex.rc.principal.id ||
      session.endpointId !== ex.rc.resolved.endpoint.endpointId
    ) {
      sendJson(ex.res, 404, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Session not found' },
      });
      return null;
    }
    return session;
  }

  private versionOf(ex: Exchange, session: SessionRecord): string | null {
    const header = first(ex.req.headers['mcp-protocol-version']);
    if (header === undefined) return session.protocolVersion;
    return (PROTOCOL_VERSIONS.legacy as readonly string[]).includes(header) ? header : null;
  }

  private contextFor(
    ex: Exchange,
    base: {
      protocolVersion: string;
      caps: ClientCaps;
      session?: SessionRecord | undefined;
      requestId?: string | number | undefined;
      meta?: JsonObject | undefined;
      signal: AbortSignal;
      emit: OpContext['emit'];
    },
  ): OpContext {
    const { rc } = ex;
    const parent: SpanContext = trace.getSpanContext(
      extractTraceContext(base.meta, ex.req.headers),
    ) ?? {
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 0,
    };
    return {
      principal: rc.principal,
      endpoint: rc.resolved.endpoint,
      era: 'legacy',
      protocolVersion: base.protocolVersion,
      clientCapabilities: base.caps,
      ...(base.session?.clientInfo === undefined ? {} : { clientInfo: base.session.clientInfo }),
      ...(base.session?.logLevel === undefined ? {} : { logLevel: base.session.logLevel }),
      trace: parent,
      signal: base.signal,
      emit: base.emit,
      resolved: rc.resolved,
      requestId: base.requestId,
      sessionId: base.session?.id,
      origin: rc.origin,
      ip: rc.ip,
      authMethod: rc.principal.authMethod,
      requestMeta: base.meta,
      path: rc.path,
    };
  }

  // --- POST ------------------------------------------------------------------------------------------------------------

  private async post(ex: Exchange): Promise<void> {
    const { body, res } = ex;
    if (Array.isArray(body)) {
      sendJson(res, 400, rpcFailure(null, invalid('JSON-RPC batches are not supported')));
      return;
    }
    const parsed = JSONRPCMessageSchema.safeParse(body);
    if (!parsed.success || !isRecord(body)) {
      sendJson(
        res,
        400,
        rpcFailure(isRecord(body) ? body.id : null, invalid('Invalid JSON-RPC message')),
      );
      return;
    }
    const method = typeof body.method === 'string' ? body.method : undefined;
    const hasId = body.id !== undefined && body.id !== null;
    if (method === 'initialize' && hasId) {
      await this.initialize(ex, body);
      return;
    }
    const session = await this.session(ex);
    if (!session) return;
    const protocolVersion = this.versionOf(ex, session);
    if (protocolVersion === null) {
      sendJson(res, 400, rpcFailure(body.id, invalid('Unsupported MCP-Protocol-Version')));
      return;
    }
    await this.store.touch(session);
    if (method === undefined) {
      await this.clientResponse(ex, session, body);
      return;
    }
    const params = isRecord(body.params) ? body.params : {};
    if (!hasId) {
      await this.notification(ex, session, protocolVersion, method, params);
      return;
    }
    await this.request(ex, session, protocolVersion, method, body.id as string | number, params);
  }

  private async initialize(ex: Exchange, body: JsonObject): Promise<void> {
    const params = InitializeRequestParamsSchema.safeParse(body.params);
    if (!params.success) {
      sendJson(ex.res, 200, rpcFailure(body.id, invalid('Invalid initialize parameters')));
      return;
    }
    const requested = params.data.protocolVersion;
    const protocolVersion = (PROTOCOL_VERSIONS.legacy as readonly string[]).includes(requested)
      ? requested
      : (PROTOCOL_VERSIONS.legacy[0] as string);
    const caps = toClientCaps(params.data.capabilities);
    const controller = new AbortController();
    ex.res.on('close', () => {
      if (!ex.res.writableFinished) controller.abort();
    });
    try {
      const ctx = this.contextFor(ex, {
        protocolVersion,
        caps,
        requestId: body.id as string | number,
        meta: isRecord(isRecord(body.params) ? body.params._meta : undefined)
          ? ((body.params as JsonObject)._meta as JsonObject)
          : undefined,
        signal: controller.signal,
        emit: () => undefined,
      });
      const outcome = await this.deps.run(
        'initialize',
        { ...params.data },
        {
          ...ctx,
          clientInfo: params.data.clientInfo,
        },
      );
      if (outcome.kind !== 'complete' || !isRecord(outcome.result)) {
        throw new Error('initialize did not complete');
      }
      const negotiated =
        typeof outcome.result.protocolVersion === 'string'
          ? outcome.result.protocolVersion
          : protocolVersion;
      const id = (this.deps.sessionIdGenerator ?? newSessionId)();
      await this.store.create({
        id,
        principalId: ex.rc.principal.id,
        tokenHash: ex.rc.tokenHash,
        endpointId: ex.rc.resolved.endpoint.endpointId,
        protocolVersion: negotiated,
        clientCapabilities: caps,
        clientInfo: params.data.clientInfo,
      });
      sendJson(
        ex.res,
        200,
        { jsonrpc: '2.0', id: body.id, result: outcome.result },
        {
          'mcp-session-id': id,
        },
      );
    } catch (error) {
      sendJson(ex.res, 200, rpcFailure(body.id, error));
    }
  }

  private async notification(
    ex: Exchange,
    session: SessionRecord,
    protocolVersion: string,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    if (method === 'notifications/cancelled') {
      const requestId = params.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.inflight.get(`${session.id}:${requestId}`)?.abort();
        await this.deps.redis.publish(
          REDIS_CHANNELS.session(session.id),
          JSON.stringify({ type: 'cancel', requestId }),
        );
      }
    } else if (method === 'notifications/initialized') {
      try {
        const ctx = this.contextFor(ex, {
          protocolVersion,
          caps: session.clientCapabilities,
          session,
          signal: new AbortController().signal,
          emit: () => undefined,
        });
        await this.deps.run(method, params, ctx);
      } catch (error) {
        this.logger.debug('notification operation failed', { method, error: String(error) });
      }
    }
    sendStatus(ex.res, 202);
  }

  // --- client responses to server-to-client requests (6.5) ---------------------------------------------------------------

  private async clientResponse(
    ex: Exchange,
    session: SessionRecord,
    body: JsonObject,
  ): Promise<void> {
    const id = body.id;
    if (typeof id === 'string' || typeof id === 'number') {
      if (this.pending.has(`${session.id}:${id}`)) {
        await this.deliverResponse(session.id, body);
      } else {
        const owner = await this.deps.redis.get(redisKeys.pendingResponse(session.id, id));
        if (owner === null) {
          this.logger.debug('response to an unknown server request', { sessionId: session.id });
        } else if (owner === this.deps.workers.workerId) {
          await this.deliverResponse(session.id, body);
        } else {
          const worker = await this.deps.workers.lookup(owner);
          if (worker) {
            await this.deps.forwarder
              .forwardSessionResponse(worker.address, session.id, body)
              .catch((error: unknown) =>
                this.logger.warn('could not forward a client response', { error: String(error) }),
              );
          }
        }
      }
    }
    sendStatus(ex.res, 202);
  }

  async deliverResponse(sessionId: string, message: unknown): Promise<void> {
    if (!isRecord(message)) return;
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    this.pending.get(`${sessionId}:${id}`)?.(message);
  }

  // --- POST requests ---------------------------------------------------------------------------------------------------

  private async request(
    ex: Exchange,
    session: SessionRecord,
    protocolVersion: string,
    method: string,
    requestId: string | number,
    params: JsonObject,
  ): Promise<void> {
    const { res } = ex;
    const key = `${session.id}:${requestId}`;
    const controller = new AbortController();
    this.inflight.set(key, controller);
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const unsubscribe = await this.onChannel(session.id, (raw) => {
      const msg = parseChannel(raw);
      if (msg?.type === 'cancel' && msg.requestId === requestId) controller.abort();
    });
    const accept = first(ex.req.headers.accept) ?? '';
    const sse =
      SSE_METHODS.has(method) && accept.includes('text/event-stream')
        ? new SseStream(res)
        : undefined;
    if (sse) this.track('response', sse);
    try {
      const meta = isRecord(params._meta) ? params._meta : undefined;
      const caps = sse ? session.clientCapabilities : {};
      const ctx = this.contextFor(ex, {
        protocolVersion,
        caps: session.clientCapabilities,
        session,
        requestId,
        meta,
        signal: controller.signal,
        emit: (n) =>
          sse?.write({
            jsonrpc: '2.0',
            method: n.method,
            ...(n.params ? { params: n.params } : {}),
          }),
      });
      const result = await driveLegacyInput({
        params,
        caps,
        roots: this.deps.roots,
        run: (p) => this.deps.run(method, p, ctx),
        ask: sse ? (m, p) => this.ask(sse, session.id, controller.signal, m, p) : undefined,
      });
      await this.afterSuccess(session, method, params);
      if (controller.signal.aborted) {
        sse?.end();
        if (!sse) sendStatus(res, 200);
        return;
      }
      const message = { jsonrpc: '2.0', id: requestId, result };
      if (sse) {
        sse.write(message);
        sse.end();
      } else sendJson(res, 200, message);
    } catch (error) {
      const message = rpcFailure(requestId, error);
      if (sse) {
        sse.write(message);
        sse.end();
      } else sendJson(res, 200, message);
    } finally {
      this.inflight.delete(key);
      unsubscribe();
    }
  }

  private async afterSuccess(
    session: SessionRecord,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    if (method === 'logging/setLevel' && typeof params.level === 'string') {
      await this.store.setLogLevel(session.id, params.level);
    } else if (
      (method === 'resources/subscribe' || method === 'resources/unsubscribe') &&
      typeof params.uri === 'string'
    ) {
      const current = (await this.store.get(session.id))?.subs ?? [];
      const next = new Set(current);
      if (method === 'resources/subscribe') next.add(params.uri);
      else next.delete(params.uri);
      await this.store.setSubs(session.id, [...next]);
    }
  }

  /** One server-to-client request on the POST's SSE stream; resolves with the entry for `inputResponses` (6.5). */
  private async ask(
    sse: SseStream,
    sessionId: string,
    signal: AbortSignal,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = `bstn-${randomBytes(8).toString('hex')}`;
    const key = `${sessionId}:${id}`;
    const timeoutMs = this.deps.pendingResponseTimeoutMs ?? TTL.pendingResponse * 1000;
    await this.deps.redis.set(
      redisKeys.pendingResponse(sessionId, id),
      this.deps.workers.workerId,
      'EX',
      TTL.pendingResponse,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const answer = new Promise<unknown>((resolve) => {
      this.pending.set(key, (message) => {
        resolve(
          isRecord(message.error)
            ? { error: { code: errorCode(message.error), message: errorMessage(message.error) } }
            : message.result,
        );
      });
      timer = setTimeout(() => resolve(timeoutAnswer(method)), timeoutMs);
      timer.unref?.();
      onAbort = () => resolve(timeoutAnswer(method));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    sse.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    try {
      return await answer;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.pending.delete(key);
      await this.deps.redis.del(redisKeys.pendingResponse(sessionId, id)).catch(() => 0);
    }
  }

  // --- GET -------------------------------------------------------------------------------------------------------------

  private async get(ex: Exchange): Promise<void> {
    const { res } = ex;
    if (!(first(ex.req.headers.accept) ?? '').includes('text/event-stream')) {
      sendStatus(res, 406);
      return;
    }
    const session = await this.session(ex);
    if (!session) return;
    if (this.versionOf(ex, session) === null) {
      sendJson(res, 400, rpcFailure(null, invalid('Unsupported MCP-Protocol-Version')));
      return;
    }
    await this.store.touch(session);
    const streamId = randomBytes(8).toString('hex');
    const stream = new SseStream(res);
    this.track('legacy_get', stream);
    const unsubscribeChannel = await this.onChannel(session.id, (raw) => {
      const msg = parseChannel(raw);
      if (!msg) return;
      if (msg.type === 'close' || (msg.type === 'replace' && msg.by !== streamId)) stream.end();
      else if (msg.type === 'notification') {
        stream.write({
          jsonrpc: '2.0',
          method: msg.method,
          ...(msg.params ? { params: msg.params } : {}),
        });
      }
    });
    await this.deps.redis.publish(
      REDIS_CHANNELS.session(session.id),
      JSON.stringify({ type: 'replace', by: streamId }),
    );
    const unregister = this.deps.hub.register(
      {
        principalId: session.principalId,
        teamIds: ex.rc.principal.teams.map((t) => t.teamId),
        endpointId: session.endpointId,
      },
      (event) => void this.forward(stream, session.id, event),
    );
    const keepAlive = setInterval(
      () => stream.comment('keepalive'),
      this.deps.keepAliveMs ?? 25_000,
    );
    keepAlive.unref?.();
    stream.onClose(() => {
      clearInterval(keepAlive);
      unregister();
      unsubscribeChannel();
    });
  }

  private async forward(stream: SseStream, sessionId: string, event: NotifyEvent): Promise<void> {
    if (event.kind === 'resource_updated') {
      if (event.uri === undefined) return;
      const current = await this.store.get(sessionId);
      if (!current?.subs.includes(event.uri)) return;
      stream.write({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: event.uri },
      });
      return;
    }
    stream.write({ jsonrpc: '2.0', method: NOTIFICATION_OF_KIND[event.kind] });
  }

  // --- DELETE ----------------------------------------------------------------------------------------------------------

  private async del(ex: Exchange): Promise<void> {
    const session = await this.session(ex);
    if (!session) return;
    await this.store.end(session.id, session.principalId);
    this.deps.metrics?.mcpServerSessionDuration.record(
      (this.clock.now() - session.createdAt) / 1000,
    );
    sendStatus(ex.res, 200);
  }
}

const toClientCaps = (raw: unknown): ClientCaps => {
  const parsed = clientCapabilitiesSchema.parse(raw);
  const caps: ClientCaps = {};
  if (parsed.sampling) caps.sampling = parsed.sampling;
  if (parsed.roots) caps.roots = parsed.roots;
  if (parsed.elicitation) {
    caps.elicitation = {
      ...(parsed.elicitation.form ? { form: parsed.elicitation.form } : {}),
      ...(parsed.elicitation.url ? { url: parsed.elicitation.url } : {}),
    };
  }
  return caps;
};

const invalid = (message: string): InvalidRequestError => new InvalidRequestError(message);

const errorCode = (e: JsonObject): number => (typeof e.code === 'number' ? e.code : -32603);
const errorMessage = (e: JsonObject): string =>
  typeof e.message === 'string' ? e.message : 'client error';

const timeoutAnswer = (method: string): unknown =>
  method === 'elicitation/create'
    ? { action: 'cancel' }
    : { error: { code: -32603, message: 'the client did not answer in time' } };

const parseChannel = (raw: string): z.infer<typeof channelMessage> | undefined => {
  try {
    const parsed = channelMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const createLegacyAdapter = (deps: LegacyAdapterDeps): LegacyAdapter =>
  new LegacyHandler(deps);

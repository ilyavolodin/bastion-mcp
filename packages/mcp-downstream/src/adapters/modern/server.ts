/**
 * The modern adapter (6.2): `createMcpHandler` from the SDK, mounted in Fastify through `toNodeHandler`. The factory
 * builds a low-level `Server` per HTTP request whose capabilities come from the effective endpoint and whose handlers call
 * operations. Header validation (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`), `_meta` parsing and
 * `server/discover` are the SDK's.
 */
import { extractTraceContext } from '@bastion-mcp/telemetry';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  InMemoryServerEventBus,
  inputRequired,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  Server,
  type ServerContext,
  type ServerEventBus,
} from '@modelcontextprotocol/server';
import { context, trace } from '@opentelemetry/api';
import { currentRequestContext } from '../../context';
import type { OperationDeps } from '../../operations/deps';
import { serverCapabilities, tasksDeclared } from '../../operations/basic';
import { isRecord } from '../../operations/support';
import { toRpcErrorBody } from '../../rpc';
import type { ClientCaps, ClientInfo, JsonObject, LoggingLevel, OpContext, OpOutcome } from '../../types';
import type { OpRunner } from '../contracts';

export const DEFAULT_KEEPALIVE_MS = 25_000;

/** Methods served through the SDK's request handlers (everything else goes to the fallback or `direct.ts`). */
const SDK_METHODS = [
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'tools/call',
  'prompts/get',
  'resources/read',
  'completion/complete',
] as const;

const CACHEABLE = [
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'server/discover',
] as const;

export type ModernAdapterDeps = {
  run: OpRunner;
  operationDeps: Pick<OperationDeps, 'skills' | 'logger'>;
  bus?: ServerEventBus;
  keepAliveMs?: number;
};

const asCaps = (value: unknown): ClientCaps => (isRecord(value) ? (value as ClientCaps) : {});

const asInfo = (value: unknown): ClientInfo | undefined =>
  isRecord(value) && typeof value.name === 'string' && typeof value.version === 'string'
    ? { name: value.name, version: value.version, ...(typeof value.title === 'string' ? { title: value.title } : {}) }
    : undefined;

/** The operation context of one modern request, from the authenticated request context and the SDK's per-request data. */
export const modernOpContext = (
  c: Pick<ServerContext, 'mcpReq'>,
  emit: OpContext['emit'],
): OpContext => {
  const rc = currentRequestContext();
  const envelope = (c.mcpReq.envelope ?? {}) as Record<string, unknown>;
  const meta = (c.mcpReq._meta ?? {}) as JsonObject;
  const parent = extractTraceContext(meta, rc.headers, context.active());
  const spanContext = trace.getSpanContext(parent) ?? {
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    traceFlags: 0,
  };
  const logLevel = envelope[LOG_LEVEL_META_KEY];
  return {
    principal: rc.principal,
    endpoint: rc.resolved.endpoint,
    era: 'modern',
    protocolVersion:
      typeof envelope[PROTOCOL_VERSION_META_KEY] === 'string'
        ? (envelope[PROTOCOL_VERSION_META_KEY] as string)
        : '2026-07-28',
    clientCapabilities: asCaps(envelope[CLIENT_CAPABILITIES_META_KEY]),
    clientInfo: asInfo(envelope[CLIENT_INFO_META_KEY]),
    ...(typeof logLevel === 'string' ? { logLevel: logLevel as LoggingLevel } : {}),
    trace: spanContext,
    signal: c.mcpReq.signal,
    emit,
    resolved: rc.resolved,
    requestId: c.mcpReq.id,
    origin: rc.origin,
    ip: rc.ip,
    authMethod: rc.principal.authMethod,
    requestMeta: meta,
    path: rc.path,
  };
};

/** Maps an operation outcome onto what an SDK handler returns. */
export const toSdkResult = (outcome: OpOutcome<unknown>): JsonObject => {
  switch (outcome.kind) {
    case 'complete':
      return (isRecord(outcome.result) ? outcome.result : {}) as JsonObject;
    case 'input_required':
      return inputRequired({
        ...(outcome.inputRequests === undefined ? {} : { inputRequests: outcome.inputRequests as never }),
        requestState: outcome.requestState,
      }) as unknown as JsonObject;
    case 'task':
      return outcome.task;
  }
};

/** JSON-RPC errors thrown inside SDK handlers: Bastion's errors keep their codes and `data` (6.9). */
export const toProtocolError = (error: unknown): ProtocolError => {
  const body = toRpcErrorBody(error);
  return new ProtocolError(body.code, body.message, body.data);
};

const withRetryFields = (params: JsonObject, c: Pick<ServerContext, 'mcpReq'>): JsonObject => {
  const state = c.mcpReq.requestState<string>();
  return {
    ...params,
    ...(c.mcpReq.inputResponses === undefined ? {} : { inputResponses: c.mcpReq.inputResponses }),
    ...(typeof state === 'string' ? { requestState: state } : {}),
  };
};

/** The low-level `Server` of one request (7.6 capabilities, instructions and cache hints from the endpoint). */
export const buildLowLevelServer = (deps: ModernAdapterDeps): Server => {
  const rc = currentRequestContext();
  const endpoint = rc.resolved.endpoint;
  const hint = { ttlMs: endpoint.ttlMs, cacheScope: endpoint.cacheScope } as const;
  const cacheHints = Object.fromEntries(CACHEABLE.map((m) => [m, hint]));
  const caps = serverCapabilities(endpoint, {
    skills: deps.operationDeps.skills !== undefined,
    tasks: tasksDeclared({
      clientCapabilities: asCaps(rc.meta?.[CLIENT_CAPABILITIES_META_KEY]),
      resolved: rc.resolved,
    }),
    logging: false,
  });
  const server = new Server(endpoint.serverInfo, {
    capabilities: caps,
    ...(endpoint.instructions === undefined ? {} : { instructions: endpoint.instructions }),
    cacheHints,
  } as never);
  const emitFor = (c: Pick<ServerContext, 'mcpReq'>): OpContext['emit'] => (n) => {
    void c.mcpReq
      .notify({ method: n.method, ...(n.params ? { params: n.params } : {}) } as never)
      .catch(() => undefined);
  };
  for (const method of SDK_METHODS) {
    server.setRequestHandler(method, (async (
      request: { params?: JsonObject },
      c: ServerContext,
    ) => {
      const params = withRetryFields((request.params ?? {}) as JsonObject, c);
      try {
        const outcome = await deps.run(method, params, modernOpContext(c, emitFor(c)));
        return toSdkResult(outcome);
      } catch (error) {
        throw toProtocolError(error);
      }
    }) as never);
  }
  // Methods the SDK does not know (skills/*, other extensions) reach the operation layer, which forwards them on
  // single-installation endpoints and answers -32601 elsewhere (6.3).
  server.fallbackRequestHandler = async (request, c) => {
    const params = withRetryFields((request.params ?? {}) as JsonObject, c);
    try {
      const outcome = await deps.run(request.method, params, modernOpContext(c, emitFor(c)));
      return toSdkResult(outcome) as never;
    } catch (error) {
      throw toProtocolError(error);
    }
  };
  return server;
};

export type ModernAdapter = {
  /** The Node `(req, res, parsedBody)` handler of the SDK; `req.auth` carries the verified principal. */
  node: ReturnType<typeof toNodeHandler>;
  handler: ReturnType<typeof createMcpHandler>;
  close(): Promise<void>;
};

export const createModernAdapter = (deps: ModernAdapterDeps): ModernAdapter => {
  const handler = createMcpHandler(() => buildLowLevelServer(deps), {
    legacy: 'reject',
    keepAliveMs: deps.keepAliveMs ?? DEFAULT_KEEPALIVE_MS,
    bus: deps.bus ?? new InMemoryServerEventBus(),
    onerror: (error) => deps.operationDeps.logger.debug('mcp handler error', { error: String(error) }),
  });
  return {
    node: toNodeHandler(handler, {
      onerror: (error) => deps.operationDeps.logger.warn('mcp handler failed', { error: String(error) }),
    }),
    handler,
    close: () => handler.close(),
  };
};

/**
 * Requests Bastion serves itself on the modern era instead of through the SDK handler, because the SDK 2.2.0 cannot
 * carry them (6.8):
 *
 * - `tasks/get`, `tasks/update` and `tasks/cancel`: the SDK's 2026-07-28 registry answers `-32601` for the first and last
 *   before any handler runs (they are 2025-era vocabulary there).
 * - `tools/call` from a client that declared the Tasks extension: the SDK validates every `tools/call` handler result as
 *   a `CallToolResult`, which rejects a `CreateTaskResult` (`resultType: "task"`).
 *
 * The same validation the SDK ladder performs applies: `Mcp-Method` and `Mcp-Name` against the body, the protocol
 * version header against the `_meta` envelope, the envelope itself.
 */
import { isRecord, JSONRPC_CODES } from '@bastion-mcp/core';
import { TASKS_EXTENSION } from '@bastion-mcp/mcp-upstream';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TRANSPORT_CODES, toRpcErrorBody } from '../../rpc';
import type { JsonObject, OpOutcome } from '../../types';
import type { Exchange, OpRunner } from '../contracts';
import { first, inputRequiredPayload, isModernVersion, sseMessageFrame } from '../shared';
import { modernOpContext } from './server';

export const TASK_METHODS: ReadonlySet<string> = new Set([
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
]);

const envelopeSchema = z.looseObject({
  [PROTOCOL_VERSION_META_KEY]: z.string(),
  [CLIENT_INFO_META_KEY]: z.looseObject({ name: z.string(), version: z.string() }),
  [CLIENT_CAPABILITIES_META_KEY]: z.looseObject({}),
});

const requestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.looseObject({
    taskId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    _meta: z.unknown(),
  }),
});

const declaresTasks = (caps: unknown): boolean => {
  const extensions = isRecord(caps) ? caps.extensions : undefined;
  return isRecord(extensions) && TASKS_EXTENSION in extensions;
};

/** True when this exchange is served here (decided from the `Mcp-Method` header and the declared extensions). */
export const isDirectExchange = (exchange: Exchange): boolean => {
  const method = first(exchange.req.headers['mcp-method']) ?? '';
  if (TASK_METHODS.has(method)) return true;
  if (method !== 'tools/call') return false;
  const meta = exchange.rc.meta;
  return declaresTasks(meta?.[CLIENT_CAPABILITIES_META_KEY]);
};

/** One JSON response, upgraded to an SSE stream when the operation emits notifications before it ends. */
class Writer {
  private sse = false;
  constructor(private readonly exchange: Exchange) {}

  emit(method: string, params?: JsonObject): void {
    const { res } = this.exchange;
    if (res.writableEnded || res.destroyed) return;
    if (!this.sse) {
      this.sse = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
    }
    res.write(sseMessageFrame({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
  }

  finish(status: number, body: unknown): void {
    const { res } = this.exchange;
    if (res.writableEnded || res.destroyed) return;
    if (this.sse) {
      res.write(sseMessageFrame(body));
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

const withEnvelope = (
  result: JsonObject,
  serverInfo: JsonObject,
  resultType: string,
): JsonObject => ({
  ...result,
  resultType: typeof result.resultType === 'string' ? result.resultType : resultType,
  _meta: {
    ...(isRecord(result._meta) ? result._meta : {}),
    'io.modelcontextprotocol/serverInfo': serverInfo,
  },
});

const toResult = (outcome: OpOutcome<unknown>, serverInfo: JsonObject): JsonObject => {
  switch (outcome.kind) {
    case 'complete':
      return withEnvelope(isRecord(outcome.result) ? outcome.result : {}, serverInfo, 'complete');
    case 'task':
      return withEnvelope(outcome.task, serverInfo, 'task');
    case 'input_required':
      return withEnvelope(inputRequiredPayload(outcome), serverInfo, 'input_required');
  }
};

export const createDirectHandler = (deps: { run: OpRunner }) => ({
  async handle(exchange: Exchange): Promise<void> {
    const writer = new Writer(exchange);
    const fail = (
      id: string | number | null,
      status: number,
      code: number,
      message: string,
      data?: Record<string, unknown>,
    ): void =>
      writer.finish(status, {
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(data ? { data } : {}) },
      });
    const parsed = requestSchema.safeParse(exchange.body);
    if (!parsed.success) return fail(null, 400, JSONRPC_CODES.INVALID_REQUEST, 'Invalid Request');
    const { id, method, params } = parsed.data;
    const headers = exchange.req.headers;
    const isTask = TASK_METHODS.has(method);
    const target = isTask ? params.taskId : params.name;
    if (target === undefined)
      return fail(
        id,
        400,
        JSONRPC_CODES.INVALID_PARAMS,
        `Invalid params: ${isTask ? 'taskId' : 'name'} is required`,
      );
    const mismatch = (headerValue: string | undefined, body: string) =>
      fail(
        id,
        400,
        TRANSPORT_CODES.headerMismatch,
        'Bad Request: the request headers and body disagree',
        {
          mismatch: { header: headerValue ?? '(missing)', body },
        },
      );
    if (first(headers['mcp-method']) !== method)
      return mismatch(first(headers['mcp-method']), method);
    if (first(headers['mcp-name']) !== target) return mismatch(first(headers['mcp-name']), target);
    const envelope = envelopeSchema.safeParse(params._meta);
    if (!envelope.success)
      return fail(id, 400, JSONRPC_CODES.INVALID_PARAMS, 'Invalid params: _meta envelope');
    const version = first(headers['mcp-protocol-version']);
    const claimed = envelope.data[PROTOCOL_VERSION_META_KEY];
    if (version !== claimed || !isModernVersion(claimed)) {
      return mismatch(version, claimed);
    }
    if (isTask && !declaresTasks(envelope.data[CLIENT_CAPABILITIES_META_KEY])) {
      return fail(id, 404, JSONRPC_CODES.METHOD_NOT_FOUND, 'Method not found');
    }
    const { _meta, ...rest } = params;
    const controller = new AbortController();
    exchange.res.on('close', () => {
      if (!exchange.res.writableFinished) controller.abort(new Error('client closed the request'));
    });
    const mcpReq = {
      id,
      method,
      _meta: _meta as never,
      envelope: envelope.data as never,
      signal: controller.signal,
      requestState: () => undefined,
      send: undefined as never,
      notify: async () => undefined,
    };
    const serverInfo = exchange.rc.resolved.endpoint.serverInfo as unknown as JsonObject;
    try {
      const outcome = await deps.run(
        method,
        // The MRTR retry fields stay in the params for the operation layer (6.5).
        rest as JsonObject,
        modernOpContext({ mcpReq } as never, (n) => writer.emit(n.method, n.params)),
      );
      writer.finish(200, { jsonrpc: '2.0', id, result: toResult(outcome, serverInfo) });
    } catch (error) {
      writer.finish(200, { jsonrpc: '2.0', id, error: toRpcErrorBody(error) });
    }
  },
});

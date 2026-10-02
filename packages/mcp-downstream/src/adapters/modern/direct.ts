/**
 * Methods the SDK's 2026-07-28 registry does not carry: the Tasks extension's `tasks/get`, `tasks/update` and
 * `tasks/cancel` (6.8). The SDK answers them `-32601` before any handler runs (its registry keeps `tasks/get` and
 * `tasks/cancel` as 2025-era vocabulary only), so Bastion serves them itself with the same validation: `Mcp-Method`
 * and `Mcp-Name` (the task id) against the body, the protocol version header against the `_meta` envelope.
 */
import { PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { TASKS_EXTENSION } from '@bastion-mcp/mcp-upstream';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { context } from '@opentelemetry/api';
import { z } from 'zod';
import { currentRequestContext } from '../../context';
import { isRecord } from '../../operations/support';
import { toRpcErrorBody } from '../../rpc';
import type { JsonObject } from '../../types';
import type { Exchange, OpRunner } from '../contracts';
import { modernOpContext } from './server';

export const DIRECT_METHODS: ReadonlySet<string> = new Set(['tasks/get', 'tasks/update', 'tasks/cancel']);

const envelopeSchema = z.looseObject({
  [PROTOCOL_VERSION_META_KEY]: z.string(),
  [CLIENT_INFO_META_KEY]: z.looseObject({ name: z.string(), version: z.string() }),
  [CLIENT_CAPABILITIES_META_KEY]: z.looseObject({}),
});

const requestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.looseObject({ taskId: z.string().min(1), _meta: z.unknown() }),
});

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const send = (exchange: Exchange, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  exchange.res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  exchange.res.end(payload);
};

const reject = (
  exchange: Exchange,
  id: string | number | null,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void =>
  send(exchange, status, { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/** True when this exchange is for a method served here (checked on the `Mcp-Method` header, as the SDK does). */
export const isDirectExchange = (exchange: Exchange): boolean =>
  DIRECT_METHODS.has(header(exchange.req.headers['mcp-method']) ?? '');

export const createDirectHandler = (deps: {
  run: OpRunner;
  serverInfo: (rc: Exchange['rc']) => JsonObject;
}) => ({
  async handle(exchange: Exchange): Promise<void> {
    const parsed = requestSchema.safeParse(exchange.body);
    if (!parsed.success) return reject(exchange, null, 400, -32600, 'Invalid Request');
    const { id, method, params } = parsed.data;
    const headers = exchange.req.headers;
    if (header(headers['mcp-method']) !== method) {
      return reject(exchange, id, 400, -32020, 'Bad Request: the request headers and body disagree', {
        mismatch: { header: header(headers['mcp-method']) ?? '(missing)', body: method },
      });
    }
    if (header(headers['mcp-name']) !== params.taskId) {
      return reject(exchange, id, 400, -32020, 'Bad Request: the request headers and body disagree', {
        mismatch: { header: header(headers['mcp-name']) ?? '(missing)', body: params.taskId },
      });
    }
    const envelope = envelopeSchema.safeParse(params._meta);
    if (!envelope.success) return reject(exchange, id, 400, -32602, 'Invalid params: _meta envelope');
    const version = header(headers['mcp-protocol-version']);
    const claimed = envelope.data[PROTOCOL_VERSION_META_KEY];
    if (version !== claimed || !(PROTOCOL_VERSIONS.modern as readonly string[]).includes(claimed)) {
      return reject(exchange, id, 400, -32020, 'Bad Request: the request headers and body disagree', {
        mismatch: { header: version ?? '(missing)', body: claimed },
      });
    }
    const declared = envelope.data[CLIENT_CAPABILITIES_META_KEY];
    const extensions = isRecord(declared) ? declared.extensions : undefined;
    if (!isRecord(extensions) || !(TASKS_EXTENSION in extensions)) {
      return reject(exchange, id, 404, -32601, 'Method not found');
    }
    const { _meta, ...rest } = params;
    const rpcContext = {
      mcpReq: {
        id,
        method,
        _meta: _meta as never,
        envelope: envelope.data as never,
        signal: abortOnClose(exchange),
        requestState: () => undefined,
        send: undefined as never,
        notify: async () => undefined,
      },
    };
    try {
      const outcome = await deps.run(
        method,
        rest as JsonObject,
        modernOpContext(rpcContext as never, () => undefined),
      );
      const result = outcome.kind === 'complete' ? outcome.result : outcome.kind === 'task' ? outcome.task : {};
      send(exchange, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          ...(isRecord(result) ? result : {}),
          resultType: 'complete',
          _meta: { ...(isRecord(result) && isRecord(result._meta) ? result._meta : {}), 'io.modelcontextprotocol/serverInfo': deps.serverInfo(exchange.rc) },
        },
      });
    } catch (error) {
      const body = toRpcErrorBody(error);
      send(exchange, 200, { jsonrpc: '2.0', id, error: body });
    }
  },
});

const abortOnClose = (exchange: Exchange): AbortSignal => {
  const controller = new AbortController();
  exchange.res.on('close', () => {
    if (!exchange.res.writableFinished) controller.abort(new Error('client closed the request'));
  });
  return controller.signal;
};

export { context as _context };

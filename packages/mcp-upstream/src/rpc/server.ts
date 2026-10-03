import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256Hex } from '@bastion-mcp/core';
import {
  INTERNAL_SIG_HEADER,
  INTERNAL_TS_HEADER,
  verifyInternalRequest,
} from '@bastion-mcp/secrets';
import { extractTraceContext, SPAN_NAMES } from '@bastion-mcp/telemetry';
import { context, SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { type Clock, type Logger, noopLogger, systemClock } from '../ports';
import { UPSTREAM_TIMEOUTS_MS } from '../timeouts';
import type { UpstreamOutcome } from '../types';
import {
  matchRoute,
  type OpBody,
  type OpEvent,
  opBodySchema,
  type ResumeBody,
  resumeBodySchema,
  type SubscriptionBody,
  sessionResponseBodySchema,
  subscriptionBodySchema,
  toErrorEvent,
} from './protocol';

/**
 * The owner's internal RPC (21.2) as framework-agnostic handlers. Every request carries `X-Bastion-Ts` and
 * `X-Bastion-Sig`; the owner trusts the signed request and never re-authenticates the downstream token.
 */

export type RpcRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | string;
};

export type RpcResponse = {
  status: number;
  headers: Record<string, string>;
  /** JSON text, or NDJSON events for streaming routes. */
  body: AsyncIterable<string> | string;
};

/** What the owner does for each route; `UpstreamService` implements it. */
export interface InternalRpcHandlers {
  op(
    instanceId: string,
    body: OpBody,
    emit: (event: OpEvent) => void,
    signal: AbortSignal,
  ): Promise<UpstreamOutcome>;
  resume(
    continuationId: string,
    body: ResumeBody,
    emit: (event: OpEvent) => void,
    signal: AbortSignal,
  ): Promise<UpstreamOutcome>;
  subscriptions(instanceId: string, body: SubscriptionBody): Promise<void>;
  /** Delivers a legacy client's JSON-RPC response to the worker that issued the request (6.5); implemented downstream. */
  sessionResponse?(sessionId: string, message: unknown): Promise<void>;
}

export type InternalRpcServerOptions = {
  /** `BASTION_INTERNAL_SECRET` and the previous one during rotation. */
  secret: string;
  previousSecret?: string | undefined;
  handlers: InternalRpcHandlers;
  clock?: Clock;
  logger?: Logger;
  tracer?: Tracer;
};

const json = (status: number, body: unknown): RpcResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const createInternalRpcServer = (options: InternalRpcServerOptions) => {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const tracer = options.tracer ?? trace.getTracer('bastion-mcp-upstream');

  const authenticate = (req: RpcRequest): RpcResponse | undefined => {
    const lower = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), headerValue(v)]),
    );
    const ts = Number(lower[INTERNAL_TS_HEADER.toLowerCase()]);
    const signature = lower[INTERNAL_SIG_HEADER.toLowerCase()];
    if (!signature || !Number.isFinite(ts)) return json(401, { error: 'missing signature' });
    const verdict = verifyInternalRequest({
      ts,
      method: req.method,
      path: req.path,
      body: req.body,
      signature,
      secret: options.secret,
      previousSecret: options.previousSecret,
      now: clock.now(),
    });
    return verdict.ok
      ? undefined
      : json(401, { error: 'invalid signature', reason: verdict.reason });
  };

  /** Runs a streaming handler and yields NDJSON lines: notifications as they come, then one outcome or error. */
  const stream = (
    spanName: string,
    carrier: Record<string, string>,
    run: (emit: (e: OpEvent) => void, signal: AbortSignal) => Promise<UpstreamOutcome>,
    signal: AbortSignal,
  ): AsyncIterable<string> => {
    const queue: OpEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const push = (event: OpEvent): void => {
      queue.push(event);
      wake?.();
    };
    const parent = extractTraceContext(undefined, carrier, context.active());
    void context.with(parent, () =>
      tracer.startActiveSpan(spanName, { kind: SpanKind.SERVER }, async (span) => {
        try {
          const outcome = await run(push, signal);
          push({ type: 'outcome', outcome });
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          push(toErrorEvent(error));
        } finally {
          span.end();
          finished = true;
          wake?.();
        }
      }),
    );
    return (async function* () {
      while (true) {
        const event = queue.shift();
        if (event) {
          yield `${JSON.stringify(event)}\n`;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })();
  };

  const handle = async (
    req: RpcRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RpcResponse> => {
    const route = matchRoute(req.method, req.path);
    if (!route) return json(404, { error: 'not found' });
    const denied = authenticate(req);
    if (denied) {
      logger.warn('internal rpc rejected', { path: req.path });
      return denied;
    }
    let body: unknown;
    try {
      body = JSON.parse(typeof req.body === 'string' ? req.body : req.body.toString('utf8'));
    } catch {
      return json(400, { error: 'invalid JSON' });
    }
    const carrier: Record<string, string> = {};
    const traceparent = headerValue(req.headers.traceparent);
    if (traceparent) carrier.traceparent = traceparent;
    const tracestate = headerValue(req.headers.tracestate);
    if (tracestate) carrier.tracestate = tracestate;
    const ndjson = { 'content-type': 'application/x-ndjson' };
    switch (route.kind) {
      case 'op': {
        const parsed = opBodySchema.safeParse(body);
        if (!parsed.success)
          return json(400, { error: 'invalid body', issues: parsed.error.issues });
        const { handlers } = options;
        return {
          status: 200,
          headers: ndjson,
          body: stream(
            SPAN_NAMES.forward(parsed.data.method),
            carrier,
            (emit, sig) => handlers.op(route.instanceId, parsed.data, emit, sig),
            signal,
          ),
        };
      }
      case 'resume': {
        const parsed = resumeBodySchema.safeParse(body);
        if (!parsed.success)
          return json(400, { error: 'invalid body', issues: parsed.error.issues });
        const { handlers } = options;
        return {
          status: 200,
          headers: ndjson,
          body: stream(
            SPAN_NAMES.forward('continuations/resume'),
            carrier,
            (emit, sig) => handlers.resume(route.continuationId, parsed.data, emit, sig),
            signal,
          ),
        };
      }
      case 'subscriptions': {
        const parsed = subscriptionBodySchema.safeParse(body);
        if (!parsed.success)
          return json(400, { error: 'invalid body', issues: parsed.error.issues });
        try {
          await options.handlers.subscriptions(route.instanceId, parsed.data);
          return json(200, { ok: true });
        } catch (error) {
          return json(200, toErrorEvent(error));
        }
      }
      case 'sessionResponse': {
        const parsed = sessionResponseBodySchema.safeParse(body);
        if (!parsed.success) return json(400, { error: 'invalid body' });
        if (!options.handlers.sessionResponse) return json(404, { error: 'not handled here' });
        try {
          await options.handlers.sessionResponse(route.sessionId, parsed.data.message);
          return json(202, { ok: true });
        } catch (error) {
          return json(200, toErrorEvent(error));
        }
      }
    }
  };

  /** `node:http` adapter; stream close aborts the operation (cancels the upstream request). */
  const nodeHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort(new Error('forward stream closed'));
      });
      const response = await handle(
        {
          method: req.method ?? 'GET',
          path: (req.url ?? '/').split('?')[0] ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks),
        },
        abort.signal,
      );
      res.writeHead(response.status, response.headers);
      if (typeof response.body === 'string') {
        res.end(response.body);
        return;
      }
      for await (const line of response.body) {
        if (!res.write(line)) await new Promise<void>((resolve) => res.once('drain', resolve));
      }
      res.end();
    })().catch((error) => {
      logger.error('internal rpc handler failed', { error: String(error) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };

  const listen = async (
    port: number,
    host = '0.0.0.0',
  ): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = http.createServer(nodeHandler);
    server.keepAliveTimeout = UPSTREAM_TIMEOUTS_MS.rpcKeepAlive;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    return {
      port: (server.address() as AddressInfo).port,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };

  return { handle, nodeHandler, listen, bodyDigest: sha256Hex };
};

export type InternalRpcServer = ReturnType<typeof createInternalRpcServer>;

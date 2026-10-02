import { UpstreamUnavailableError } from '@bastion-mcp/core';
import { INTERNAL_SIG_HEADER, INTERNAL_TS_HEADER, signInternalRequest } from '@bastion-mcp/secrets';
import { type BastionMetrics, injectTraceContext, SPAN_NAMES } from '@bastion-mcp/telemetry';
import { SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { Agent, request } from 'undici';
import { type Clock, systemClock } from '../ports';
import type { UpstreamNotification, UpstreamOutcome, WireContext } from '../types';
import {
  fromErrorEvent,
  type OpEvent,
  opEventSchema,
  opPath,
  resumePath,
  type SubscriptionBody,
  sessionResponsePath,
  subscriptionsPath,
} from './protocol';

/** The forward could not reach the owner (connection refused or reset before any event): retry once (21.2). */
export class ForwardConnectError extends Error {
  constructor(address: string, cause: unknown) {
    super(`could not reach worker ${address}`, { cause });
    this.name = 'ForwardConnectError';
  }
}

export type InternalRpcClientOptions = {
  /** `BASTION_INTERNAL_SECRET` */
  secret: string;
  clock?: Clock;
  tracer?: Tracer;
  metrics?: Pick<BastionMetrics, 'forwardedRequests'> | undefined;
  /** HTTP/1.1 keep-alive towards other workers on port 7443. */
  agent?: Agent;
  /** Fallback timeout when the context has no deadline. */
  defaultTimeoutMs?: number;
};

const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return cause ? errorCode(cause) : undefined;
};

export class InternalRpcClient {
  private readonly clock: Clock;
  private readonly tracer: Tracer;
  private readonly agent: Agent;

  constructor(private readonly options: InternalRpcClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.tracer = options.tracer ?? trace.getTracer('bastion-mcp-upstream');
    this.agent =
      options.agent ??
      new Agent({ keepAliveTimeout: 60_000, connections: 128, connect: { timeout: 5_000 } });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private sign(method: string, path: string, body: string): Record<string, string> {
    const ts = this.clock.now();
    return {
      'content-type': 'application/json',
      [INTERNAL_TS_HEADER]: String(ts),
      [INTERNAL_SIG_HEADER]: signInternalRequest({
        ts,
        method,
        path,
        body,
        secret: this.options.secret,
      }),
    };
  }

  private async post(
    address: string,
    path: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
  ) {
    const body = JSON.stringify(payload);
    const headers = this.sign('POST', path, body);
    injectTraceContext({}, headers);
    const timeout = AbortSignal.timeout(
      deadlineAt === undefined
        ? (this.options.defaultTimeoutMs ?? 35 * 60_000)
        : Math.max(1, deadlineAt - this.clock.now()) + 5_000,
    );
    try {
      return await request(`http://${address}${path}`, {
        method: 'POST',
        headers,
        body,
        dispatcher: this.agent,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && CONNECT_ERRORS.has(code))
        throw new ForwardConnectError(address, error);
      throw error;
    }
  }

  /** Reads the NDJSON stream: notifications to `onNotification`, then the outcome (or the typed error). */
  private async consume(
    response: Awaited<ReturnType<InternalRpcClient['post']>>,
    onNotification: ((n: UpstreamNotification) => void) | undefined,
    installation: string,
  ): Promise<UpstreamOutcome> {
    if (response.statusCode !== 200) {
      const text = await response.body.text().catch(() => '');
      throw new UpstreamUnavailableError(
        `worker answered ${response.statusCode}: ${text.slice(0, 200)}`,
        {
          installation,
        },
      );
    }
    let pending = '';
    let outcome: UpstreamOutcome | undefined;
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      const event: OpEvent = opEventSchema.parse(JSON.parse(line));
      if (event.type === 'notification') {
        onNotification?.({
          method: event.method,
          ...(event.params ? { params: event.params } : {}),
        });
      } else if (event.type === 'outcome') {
        outcome = event.outcome as UpstreamOutcome;
      } else {
        throw fromErrorEvent(event);
      }
    };
    try {
      response.body.setEncoding('utf8');
      for await (const chunk of response.body as AsyncIterable<string>) {
        pending += chunk;
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          handleLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf('\n');
        }
      }
      handleLine(pending);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new UpstreamUnavailableError('the owner worker sent an invalid event', {
          installation,
        });
      }
      const code = errorCode(error);
      if (code !== undefined && (CONNECT_ERRORS.has(code) || code === 'UND_ERR_ABORTED')) {
        // The owner died mid-call (21.3): in-flight requests fail with -32014.
        throw new UpstreamUnavailableError(
          'the worker running this call is gone',
          { installation },
          error,
        );
      }
      throw error;
    }
    if (!outcome) {
      throw new UpstreamUnavailableError('the owner worker closed the stream without an outcome', {
        installation,
      });
    }
    return outcome;
  }

  private async withSpan<T>(method: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(
      SPAN_NAMES.forward(method),
      { kind: SpanKind.CLIENT },
      async (span) => {
        try {
          const result = await fn();
          this.options.metrics?.forwardedRequests.add(1, { outcome: 'ok' });
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          this.options.metrics?.forwardedRequests.add(1, {
            outcome: error instanceof ForwardConnectError ? 'connect_failed' : 'error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /** `POST /internal/v1/instances/{id}/op` */
  forwardOp(
    address: string,
    instanceId: string,
    body: { method: string; params: Record<string, unknown>; ctx: WireContext },
    options: {
      signal?: AbortSignal | undefined;
      onNotification?: ((n: UpstreamNotification) => void) | undefined;
    } = {},
  ): Promise<UpstreamOutcome> {
    return this.withSpan(body.method, async () => {
      const response = await this.post(
        address,
        opPath(instanceId),
        body,
        options.signal,
        body.ctx.deadlineAt,
      );
      return this.consume(response, options.onNotification, body.ctx.installationId);
    });
  }

  /** `POST /internal/v1/continuations/{id}/resume` */
  forwardResume(
    address: string,
    continuationId: string,
    body: { inputResponses: Record<string, unknown>; ctx: WireContext },
    options: {
      signal?: AbortSignal | undefined;
      onNotification?: ((n: UpstreamNotification) => void) | undefined;
    } = {},
  ): Promise<UpstreamOutcome> {
    return this.withSpan('continuations/resume', async () => {
      const response = await this.post(
        address,
        resumePath(continuationId),
        body,
        options.signal,
        body.ctx.deadlineAt,
      );
      return this.consume(response, options.onNotification, body.ctx.installationId);
    });
  }

  /** `POST /internal/v1/instances/{id}/subscriptions` */
  async forwardSubscription(
    address: string,
    instanceId: string,
    body: SubscriptionBody,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withSpan('subscriptions', async () => {
      const response = await this.post(
        address,
        subscriptionsPath(instanceId),
        body,
        signal,
        body.ctx.deadlineAt,
      );
      const parsed = (await response.body.json()) as { ok?: boolean; type?: string };
      if (parsed.type === 'error') {
        throw fromErrorEvent(opEventSchema.parse(parsed) as Extract<OpEvent, { type: 'error' }>);
      }
    });
  }

  /** `POST /internal/v1/sessions/{sessionId}/responses` */
  async forwardSessionResponse(
    address: string,
    sessionId: string,
    message: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withSpan('sessions/responses', async () => {
      const response = await this.post(
        address,
        sessionResponsePath(sessionId),
        { message },
        signal,
        undefined,
      );
      await response.body.text();
      if (response.statusCode >= 400) {
        throw new UpstreamUnavailableError(`worker answered ${response.statusCode}`, {
          installation: '',
        });
      }
    });
  }
}

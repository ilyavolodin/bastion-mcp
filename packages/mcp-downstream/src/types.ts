/**
 * The transport-independent operation layer contract (6.2). Every MCP method is an `Operation`; the two
 * downstream adapters translate HTTP to operations and back.
 */
import type { Principal } from '@bastion-mcp/auth';
import type { Era } from '@bastion-mcp/core';
import type { InputRequestMap } from '@bastion-mcp/mcp-upstream';
import type { EffectiveEndpoint, EndpointDefinition, InstallationInfo } from '@bastion-mcp/router';
import type { SpanContext } from '@opentelemetry/api';

export type JsonObject = Record<string, unknown>;

/** What a client declared (per request on the modern era, per session on the legacy era). */
export type ClientCaps = {
  elicitation?: { form?: JsonObject; url?: JsonObject } | undefined;
  sampling?: JsonObject | undefined;
  roots?: JsonObject | undefined;
  extensions?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

export type ClientInfo = { name: string; version: string; title?: string | undefined };

export type LoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** Progress and log notifications that belong to one request (6.6). */
export type RequestScopedNotification = { method: string; params?: JsonObject | undefined };

/** The endpoint a request addressed, with what the operations need to route (7.1, 7.2). */
export type ResolvedEndpoint = {
  definition: EndpointDefinition;
  endpoint: EffectiveEndpoint;
  /** Every installation the endpoint was compiled from, by id (Cedar data, limits, call log). */
  installations: ReadonlyMap<string, InstallationInfo>;
};

export type OpContext = {
  /** User or service account, roles, teams. */
  principal: Principal;
  /** Compiled config (section 7). */
  endpoint: EffectiveEndpoint;
  era: Era;
  protocolVersion: string;
  /** Per request (modern) or per session (legacy). */
  clientCapabilities: ClientCaps;
  clientInfo?: ClientInfo | undefined;
  logLevel?: LoggingLevel | undefined;
  trace: SpanContext;
  /** Aborted on stream close or `notifications/cancelled`. */
  signal: AbortSignal;
  /** Progress and log notifications for this request. */
  emit: (n: RequestScopedNotification) => void;
  // --- additions of this implementation -------------------------------------------------------------------
  /** The compiled endpoint's installations and definition. */
  resolved: ResolvedEndpoint;
  /** JSON-RPC id of the request, when there is one. */
  requestId?: string | number | undefined;
  /** Legacy session id (`Mcp-Session-Id`). */
  sessionId?: string | undefined;
  /** `plugin` for requests that arrived on `/mcp/c/*` (25.9). */
  origin: 'client' | 'plugin';
  /** Peer address, for Cedar `context.ip` and span attributes. */
  ip: string;
  authMethod: string;
  /** The request `_meta` as sent (progress token, trace context). */
  requestMeta?: JsonObject | undefined;
  /** HTTP request path, for the Cedar `context.endpoint`. */
  path?: string | undefined;
};

export type OpOutcome<R> =
  | { kind: 'complete'; result: R }
  | {
      kind: 'input_required';
      inputRequests?: InputRequestMap | undefined;
      requestState: string;
      /** The installation the request is routed to; the legacy bridge needs it for configured roots (6.5). */
      installationId?: string | undefined;
    }
  | { kind: 'task'; task: JsonObject };

export interface Operation<P = JsonObject, R = JsonObject> {
  method: string;
  run(params: P, ctx: OpContext): Promise<OpOutcome<R>>;
}

/** Lookup of the operation behind a method name; `undefined` for methods Bastion does not serve. */
export interface OperationRegistry {
  get(method: string): Operation | undefined;
  readonly methods: readonly string[];
}

/** Notification the client sent in the context of a request or session (6.3 `notifications/*`). */
export type ClientNotification = { method: string; params?: JsonObject | undefined };

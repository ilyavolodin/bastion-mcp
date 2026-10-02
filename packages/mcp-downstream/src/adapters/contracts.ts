/**
 * Contracts between the HTTP layer, the two downstream adapters and the notification hub. The HTTP plugin
 * (`http/plugin.ts`) hands authenticated exchanges to these; each adapter owns the whole HTTP exchange from there on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BastionRequestContext } from '../context';
import type { JsonObject, OpContext, OpOutcome } from '../types';

/**
 * Runs one operation by method name with spans and metrics around it. Unknown methods are forwarded verbatim on
 * single-installation endpoints and answer `-32601` elsewhere (6.3). Throws `BastionError`s (see `rpc.ts`).
 */
export type OpRunner = (
  method: string,
  params: JsonObject,
  ctx: OpContext,
) => Promise<OpOutcome<unknown>>;

/** One authenticated HTTP exchange handed to an adapter. The Fastify reply is already hijacked: write to `res`. */
export type Exchange = {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed JSON body of a POST; `undefined` for GET and DELETE. Never `undefined` for a POST that got here. */
  body: unknown;
  rc: BastionRequestContext;
};

/** What a stream is addressed with, for event filtering (6.6). */
export type StreamTarget = {
  principalId: string;
  teamIds: readonly string[];
  endpointId: string;
};

export type NotifyKind =
  | 'tools_list_changed'
  | 'prompts_list_changed'
  | 'resources_list_changed'
  | 'resource_updated';

/** `{ targets, endpointIds?, kind, uri? }` as published on `bastion:notify` and `bastion:listen` (6.6). */
export type NotifyEvent = {
  targets: {
    principalIds?: string[] | undefined;
    teamIds?: string[] | undefined;
    all?: boolean | undefined;
  };
  endpointIds?: string[] | undefined;
  kind: NotifyKind;
  uri?: string | undefined;
};

/** The single per-worker Redis subscription (6.6); streams register interest and get matching events only. */
export interface NotifyHubPort {
  register(target: StreamTarget, handler: (event: NotifyEvent) => void): () => void;
}

/** Adapter for modern `subscriptions/listen` streams (6.6). */
export interface ListenAdapter {
  /** Handles one `subscriptions/listen` POST end to end (validates, acknowledges, streams until close). */
  handle(exchange: Exchange): Promise<void>;
  /** Writes the final graceful `complete` result and closes every stream (21.2). */
  shutdown(): Promise<void>;
  activeStreams(): number;
}

/** Adapter for the 2025-era Streamable HTTP transport (6.2). */
export interface LegacyAdapter {
  /** Handles one legacy POST, GET or DELETE end to end. */
  handle(exchange: Exchange): Promise<void>;
  /** Delivers a legacy client's JSON-RPC response to the request this worker issued (internal RPC, 6.5). */
  deliverResponse(sessionId: string, message: unknown): Promise<void>;
  /** Ends every open SSE stream (21.2). */
  shutdown(): Promise<void>;
  activeStreams(): number;
}

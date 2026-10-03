/** Small pieces both downstream adapters (and the HTTP plugin) share: headers, SSE framing, keepalive, JSON replies. */
import type { ServerResponse } from 'node:http';
import { MS, PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { inputRequiredPayload } from '@bastion-mcp/mcp-upstream';
import type { SpanContext } from '@opentelemetry/api';
import type { BastionRequestContext } from '../context';
import type { OpContext } from '../types';

/** SSE comment interval on idle streams, for every stream the adapters hold open (6.2). */
export const KEEPALIVE_MS = 25 * MS.SECOND;

/** The invalid span context: the parent of a request that arrived without trace headers. */
export const ROOT_SPAN_CONTEXT: SpanContext = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0,
};

/** First value of a header Node may deliver as a list. */
export const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** One SSE `message` event (6.2). No event ids are ever written. */
export const sseMessageFrame = (message: unknown): string =>
  `event: message\ndata: ${JSON.stringify(message)}\n\n`;

/** One SSE comment line (keepalives). */
export const sseCommentFrame = (text: string): string => `: ${text}\n\n`;

/**
 * One response: JSON when there is a body, an empty one otherwise. When headers are already out (a stream upgraded
 * meanwhile) the response is only ended.
 */
export const sendResponse = (
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (body === undefined) {
    res.writeHead(status, headers);
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

/** True for a revision of the 2025-era transport Bastion serves. */
export const isLegacyVersion = (value: unknown): value is string =>
  typeof value === 'string' && (PROTOCOL_VERSIONS.legacy as readonly string[]).includes(value);

/** True for a revision of the modern era Bastion serves. */
export const isModernVersion = (value: unknown): value is string =>
  typeof value === 'string' && (PROTOCOL_VERSIONS.modern as readonly string[]).includes(value);

/** The latest modern revision: what a request without `protocolVersion` in its envelope is taken to speak. */
export const LATEST_MODERN_VERSION: string = PROTOCOL_VERSIONS.modern[0];

export { inputRequiredPayload };

/** What differs between the eras when building an `OpContext`; the rest comes from the authenticated request. */
export type OpContextParts = Pick<
  OpContext,
  'era' | 'protocolVersion' | 'clientCapabilities' | 'trace' | 'signal' | 'emit'
> &
  Partial<Pick<OpContext, 'clientInfo' | 'logLevel' | 'requestId' | 'sessionId' | 'requestMeta'>>;

/** The part of an operation context both adapters derive the same way from the authenticated request (6.2). */
export const baseOpContext = (rc: BastionRequestContext, parts: OpContextParts): OpContext => ({
  principal: rc.principal,
  endpoint: rc.resolved.endpoint,
  resolved: rc.resolved,
  origin: rc.origin,
  ip: rc.ip,
  authMethod: rc.principal.authMethod,
  path: rc.path,
  ...parts,
});

import { META_KEYS, TIMEOUTS_MS } from '@bastion-mcp/core';
import { CLIENT_CAPABILITIES_META_KEY, LOG_LEVEL_META_KEY } from '@modelcontextprotocol/client';
import { injectTraceContext } from '@bastion-mcp/telemetry';
import type { CallPrincipal, ResolvedInstallation } from '../ports';
import type { ClientCapabilitiesLike, JsonObject, TraceCarrier } from '../types';

/** What Bastion tells an upstream about itself (6.4). */

export const BASTION_CLIENT_NAME = 'bastion';
export const BASTION_CLIENT_TITLE = 'Bastion MCP Gateway';

export const bastionClientInfo = (version: string) => ({
  name: BASTION_CLIENT_NAME,
  version,
  title: BASTION_CLIENT_TITLE,
});

/** `elicitation {form:{}, url:{}}` always; `sampling` and `roots` only when the catalog entry enables them (6.4). */
export const declaredCapabilities = (
  installation: Pick<ResolvedInstallation, 'enableSampling' | 'enableRoots'>,
): ClientCapabilitiesLike => ({
  elicitation: { form: {}, url: {} },
  ...(installation.enableSampling ? { sampling: {} } : {}),
  ...(installation.enableRoots ? { roots: {} } : {}),
});

/**
 * Modern upstreams get the declaration per request, intersected with the downstream request's capabilities (6.4).
 */
export const intersectCapabilities = (
  declared: ClientCapabilitiesLike,
  downstream: ClientCapabilitiesLike,
): ClientCapabilitiesLike => {
  const out: ClientCapabilitiesLike = {};
  const d = declared.elicitation;
  const c = downstream.elicitation;
  if (d && c) {
    const form = d.form !== undefined && (c.form !== undefined || c.url === undefined);
    const url = d.url !== undefined && c.url !== undefined;
    if (form || url) out.elicitation = { ...(form ? { form: {} } : {}), ...(url ? { url: {} } : {}) };
  }
  if (declared.sampling && downstream.sampling) out.sampling = {};
  if (declared.roots && downstream.roots) out.roots = {};
  return out;
};

export const onBehalfOf = (principal: CallPrincipal): { userId: string; clientName: string } => ({
  userId: principal.userId,
  clientName: principal.clientName ?? 'unknown',
});

export type MetaInput = {
  principal: CallPrincipal;
  trace: TraceCarrier;
  logLevel?: string | undefined;
  /** Present for modern upstreams: the per-request capability declaration. */
  capabilities?: ClientCapabilitiesLike | undefined;
};

/**
 * `params._meta` of every upstream request (6.4, 6.6): the attribution key, trace context (SEP-414), the log level
 * only when the downstream request carried one, and the per-request capabilities for modern upstreams.
 */
export const buildRequestMeta = (input: MetaInput, existing: JsonObject | undefined): JsonObject => {
  const meta: JsonObject = { ...existing, [META_KEYS.onBehalfOf]: onBehalfOf(input.principal) };
  for (const [key, value] of Object.entries(input.trace)) if (value !== undefined) meta[key] = value;
  if (input.logLevel !== undefined) meta[LOG_LEVEL_META_KEY] = input.logLevel;
  if (input.capabilities !== undefined) meta[CLIENT_CAPABILITIES_META_KEY] = input.capabilities;
  return meta;
};

/** The same trace context as HTTP headers on remote transports (6.4). */
export const traceHeaders = (trace: TraceCarrier): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(trace)) if (value !== undefined) headers[key] = value;
  return headers;
};

/** Injects the active OpenTelemetry context when the caller supplied no carrier (6.4). */
export const activeTraceCarrier = (): TraceCarrier => {
  const meta: JsonObject = {};
  const headers: Record<string, string> = {};
  injectTraceContext(meta, headers);
  return {
    ...(headers.traceparent === undefined ? {} : { traceparent: headers.traceparent }),
    ...(headers.tracestate === undefined ? {} : { tracestate: headers.tracestate }),
    ...(headers.baggage === undefined ? {} : { baggage: headers.baggage }),
  };
};

const LIST_METHODS = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
]);

/** 60 s for `tools/call`, 15 s for lists, reads and prompts; per-entry override up to 30 minutes (6.4). */
export const timeoutFor = (
  method: string,
  timeouts: { toolCallMs?: number | undefined; listMs?: number | undefined } | undefined,
): number => {
  if (method === 'tools/call') {
    return Math.min(timeouts?.toolCallMs ?? TIMEOUTS_MS.toolCall, TIMEOUTS_MS.maxOverride);
  }
  const override = LIST_METHODS.has(method) || method.startsWith('prompts/') || method.startsWith('resources/')
    ? timeouts?.listMs
    : undefined;
  return Math.min(override ?? TIMEOUTS_MS.list, TIMEOUTS_MS.maxOverride);
};

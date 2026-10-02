/** Shared building blocks of the operations: identities, Cedar inputs, upstream contexts, spans and guard application. */
import {
  canonicalDigest,
  META_KEYS,
  type RequestStateBinding,
  type TemplateContext,
  TOKEN_PREFIXES,
} from '@bastion-mcp/core';
import {
  applyQuarantine,
  applyRedactions,
  type GuardPhase,
  type GuardRunResult,
  guardMetaFor,
  type ItemRef,
  type PipelineInput,
  type TextSegment,
  toGuardBlockedError,
} from '@bastion-mcp/guards';
import type {
  CallPrincipal,
  JsonObject as UpstreamJson,
  UpstreamCallContext,
  UpstreamNotification,
} from '@bastion-mcp/mcp-upstream';
import {
  clockContext,
  type InstallationData,
  type McpRequestContext,
  type ToolAnnotations,
} from '@bastion-mcp/policy';
import type { EffectiveEndpoint, InstallationInfo } from '@bastion-mcp/router';
import { SPAN_NAMES } from '@bastion-mcp/telemetry';
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type SpanContext,
  trace,
} from '@opentelemetry/api';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, OpContext } from '../types';
import type { OperationDeps } from './deps';

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// --- identities ------------------------------------------------------------------------------------------------

export const callPrincipalOf = async (
  deps: Pick<OperationDeps, 'profiles'>,
  ctx: OpContext,
): Promise<CallPrincipal> => {
  const profile = deps.profiles ? await deps.profiles.profile(ctx.principal) : {};
  return {
    userId: ctx.principal.id,
    type: ctx.principal.type,
    ...(ctx.clientInfo?.name === undefined ? {} : { clientName: ctx.clientInfo.name }),
    ...(profile.email === undefined ? {} : { email: profile.email }),
    teams: ctx.principal.teams.map((t) => t.teamId),
  };
};

export const templateContextOf = (
  principal: CallPrincipal,
  variables: Record<string, string> | undefined,
): TemplateContext => ({
  user: {
    id: principal.userId,
    ...(principal.email === undefined ? {} : { email: principal.email }),
    ...(principal.teams === undefined ? {} : { teams: principal.teams }),
  },
  ...(variables === undefined ? {} : { var: variables }),
});

// --- Cedar (10.4, 12.4) ------------------------------------------------------------------------------------------

export const installationDataOf = (info: InstallationInfo): InstallationData => {
  if (info.policy) return info.policy;
  const data: InstallationData = { id: info.id, catalogEntryId: info.catalogEntryId };
  if (info.owner.kind === 'user') data.ownerUserId = info.owner.id;
  else if (info.owner.kind === 'team') data.ownerTeamId = info.owner.id;
  else {
    data.ownerServiceId = info.owner.id;
    if (info.owner.teamId !== undefined) data.ownerServiceTeamId = info.owner.teamId;
  }
  return data;
};

export const policyContextOf = (
  ctx: Pick<OpContext, 'principal' | 'clientInfo' | 'ip' | 'path'>,
  nowMs: number,
): McpRequestContext => ({
  clientId: ctx.principal.clientId ?? '',
  clientName: ctx.clientInfo?.name ?? '',
  ip: ctx.ip.length >= 2 ? ctx.ip : '0.0.0.0',
  authMethod: ctx.principal.authMethod,
  ...clockContext(new Date(nowMs)),
  endpoint: ctx.path ?? '',
});

const toolIndex = new WeakMap<EffectiveEndpoint, Map<string, Record<string, unknown>>>();

/** Final tool definition by final name, for annotations in the Cedar `Tool` entity (10.2). */
export const toolDefinition = (
  endpoint: EffectiveEndpoint,
  name: string,
): Record<string, unknown> | undefined => {
  let index = toolIndex.get(endpoint);
  if (!index) {
    index = new Map(endpoint.tools.map((t) => [t.name, t as Record<string, unknown>]));
    toolIndex.set(endpoint, index);
  }
  return index.get(name);
};

export const toolAnnotationsOf = (tool: Record<string, unknown> | undefined): ToolAnnotations => {
  const a = tool?.annotations;
  if (!isRecord(a)) return {};
  return {
    ...(typeof a.readOnlyHint === 'boolean' ? { readOnlyHint: a.readOnlyHint } : {}),
    ...(typeof a.destructiveHint === 'boolean' ? { destructiveHint: a.destructiveHint } : {}),
    ...(typeof a.openWorldHint === 'boolean' ? { openWorldHint: a.openWorldHint } : {}),
  };
};

// --- trace context -----------------------------------------------------------------------------------------------

export const traceCarrierOf = (sc: SpanContext): { traceparent: string } => ({
  traceparent: `00-${sc.traceId}-${sc.spanId}-${(sc.traceFlags & 0xff).toString(16).padStart(2, '0')}`,
});

/** Runs `fn` in an INTERNAL child span of the active context (15.2). */
export const withSpan = async <T>(
  deps: Pick<OperationDeps, 'tracer'>,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> =>
  deps.tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  });

// --- upstream context (6.4, 6.5) -----------------------------------------------------------------------------------

export const isSingleInstallationEndpoint = (ctx: OpContext): boolean =>
  ctx.resolved.definition.kind === 'installation' || ctx.resolved.definition.kind === 'catalog';

export const upstreamContextOf = (
  ctx: OpContext,
  principal: CallPrincipal,
  installationId: string,
  options: {
    downstreamName?: string | undefined;
    deadlineAt?: number | undefined;
    emit?: ((n: UpstreamNotification) => void) | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): UpstreamCallContext => ({
  principal,
  installationId,
  era: ctx.era,
  clientCapabilities: ctx.clientCapabilities,
  trace: traceCarrierOf(trace.getSpanContext(context.active()) ?? ctx.trace),
  endpointId: ctx.endpoint.endpointId,
  singleInstallationEndpoint: isSingleInstallationEndpoint(ctx),
  signal: options.signal ?? ctx.signal,
  ...(ctx.logLevel === undefined ? {} : { logLevel: ctx.logLevel }),
  ...(options.downstreamName === undefined ? {} : { downstreamName: options.downstreamName }),
  ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  ...(options.emit === undefined ? {} : { emit: options.emit }),
});

/** Progress tokens are replaced with `pt_` + random upstream and mapped back on the way out (6.6). */
export const remapProgress = (
  ctx: OpContext,
  newId: () => string,
): {
  upstreamMeta: UpstreamJson | undefined;
  emit: ((n: UpstreamNotification) => void) | undefined;
} => {
  const original = ctx.requestMeta?.progressToken;
  const hasToken = typeof original === 'string' || typeof original === 'number';
  const token = hasToken ? `${TOKEN_PREFIXES.progress}${newId().replace(/-/g, '')}` : undefined;
  const emit = (n: UpstreamNotification): void => {
    if (n.method === 'notifications/progress') {
      if (!hasToken) return;
      ctx.emit({ method: n.method, params: { ...(n.params ?? {}), progressToken: original } });
      return;
    }
    if (n.method === 'notifications/message') {
      if (!logAllowed(ctx.logLevel, n.params?.level)) return;
    }
    ctx.emit({ method: n.method, ...(n.params ? { params: n.params } : {}) });
  };
  return {
    upstreamMeta: token === undefined ? undefined : { progressToken: token },
    emit,
  };
};

const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

const logAllowed = (min: string | undefined, level: unknown): boolean => {
  if (min === undefined) return true;
  const minIndex = LEVELS.indexOf(min);
  const index = typeof level === 'string' ? LEVELS.indexOf(level) : -1;
  return index < 0 || minIndex < 0 || index >= minIndex;
};

// --- requestState (6.5) ----------------------------------------------------------------------------------------------

export type RetryParts = {
  inputResponses: Record<string, unknown> | undefined;
  requestState: string | undefined;
  /** The params without the retry fields. */
  rest: JsonObject;
};

/** Splits the MRTR retry fields (`inputResponses`, `requestState`) off the params (6.5). */
export const retryParts = (params: JsonObject): RetryParts => {
  const { inputResponses, requestState, ...rest } = params;
  if (requestState !== undefined && typeof requestState !== 'string') {
    throw new InvalidParamsError('invalid requestState');
  }
  if (inputResponses !== undefined && !isRecord(inputResponses)) {
    throw new InvalidParamsError('invalid inputResponses');
  }
  return {
    inputResponses: inputResponses as Record<string, unknown> | undefined,
    requestState: requestState as string | undefined,
    rest,
  };
};

export const bindingOf = (
  ctx: OpContext,
  installationId: string,
  method: string,
  name: string,
  upstreamArgs: unknown,
): RequestStateBinding => ({
  principalId: ctx.principal.id,
  endpointId: ctx.endpoint.endpointId,
  installationId,
  method,
  name,
  args: upstreamArgs,
});

export const argsDigest = (value: unknown): string => canonicalDigest(value).toString('hex');

// --- guards (13) -------------------------------------------------------------------------------------------------------

export type GuardSubject = {
  installation: InstallationInfo;
  item: ItemRef;
  method: string;
};

export const runGuards = async (
  deps: Pick<OperationDeps, 'guards' | 'guardProfiles' | 'tracer'>,
  ctx: OpContext,
  phase: GuardPhase,
  subject: GuardSubject,
  segments: TextSegment[],
  toolProfileId?: string | null,
): Promise<GuardRunResult> => {
  const input: PipelineInput = {
    phase,
    segments,
    principal: {
      principalId: ctx.principal.id,
      ...(ctx.principal.clientId === null ? {} : { clientId: ctx.principal.clientId }),
    },
    installation: { installationId: subject.installation.id, slug: subject.installation.slug },
    item: subject.item,
    method: subject.method,
  };
  const layers = deps.guardProfiles.layersFor({
    installationId: subject.installation.id,
    catalogEntryId: subject.installation.catalogEntryId,
    catalogVersionId: subject.installation.catalogVersionId,
    toolProfileId,
  });
  const started = Date.now();
  const run = await deps.guards.run(input, layers, { signal: ctx.signal });
  recordGuardSpans(deps, run, started);
  return run;
};

/** One `bastion.guard {type}` INTERNAL span per evaluated guard (15.2), laid out from the recorded latencies. */
const recordGuardSpans = (
  deps: Pick<OperationDeps, 'tracer'>,
  run: GuardRunResult,
  startedMs: number,
): void => {
  let cursor = startedMs;
  for (const record of run.records) {
    const end = cursor + Math.max(0, record.latencyMs);
    const span = deps.tracer.startSpan(SPAN_NAMES.guard(record.type), {
      kind: SpanKind.INTERNAL,
      startTime: cursor,
      attributes: {
        'bastion.guard.instance': record.guard,
        'bastion.guard.phase': record.phase,
        'bastion.guard.verdict': record.verdict,
        'bastion.guard.action': record.action,
      },
    });
    if (record.verdict === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(end);
    cursor = end;
  }
};

export type AppliedGuards = {
  /** The payload after redaction and quarantine. */
  value: unknown;
  /** `_meta` entries to merge into the result (`warn` and other non-allow outcomes, 13.2). */
  meta: Record<string, unknown>;
};

/**
 * Applies a guard result to the payload the segment paths address (13.2): `block` fails the operation,
 * redactions and quarantine rewrite it, `warn` adds `_meta`. `confirm` is the caller's business and handled before.
 */
export const applyGuardResult = (
  run: GuardRunResult,
  root: unknown,
  segments: readonly TextSegment[],
): AppliedGuards => {
  if (run.block) throw toGuardBlockedError(run);
  let value = root;
  if (run.redactions.length > 0) value = applyRedactions(value, segments, run.redactions);
  if (run.quarantine) {
    value = applyQuarantine(value, segments, run.quarantine.segments, {
      guard: run.quarantine.guard,
      score: run.quarantine.score,
    });
  }
  const meta = guardMetaFor(run);
  return { value, meta: meta ? { [meta.key]: meta.value } : {} };
};

/** Merges `_meta` entries into a result without losing what the upstream put there. */
export const withMeta = (result: JsonObject, extra: Record<string, unknown>): JsonObject => {
  if (Object.keys(extra).length === 0) return result;
  const existing = isRecord(result._meta) ? result._meta : {};
  return { ...result, _meta: { ...existing, ...extra } };
};

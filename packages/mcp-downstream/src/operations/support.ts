/** Shared building blocks of the operations: identities, Cedar inputs, upstream contexts, spans and guard application. */

import {
  canonicalDigest,
  isRecord,
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
  UpstreamCallContext,
  JsonObject as UpstreamJson,
  UpstreamNotification,
} from '@bastion-mcp/mcp-upstream';
import { SPAN_ATTRS } from '@bastion-mcp/mcp-upstream';
import type { InstallationData, McpRequestContext, ToolAnnotations } from '@bastion-mcp/policy';
import type { EffectiveEndpoint, InstallationInfo } from '@bastion-mcp/router';
import { SPAN_NAMES } from '@bastion-mcp/telemetry';
import {
  context,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { InvalidParamsError } from '../rpc';
import { type JsonObject, LOGGING_LEVELS, type OpContext } from '../types';
import type { OperationDeps } from './deps';

export { isRecord };

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

/** Whether a pinned-argument plan holds `{{var.*}}` templates that need the installation's variables (12.4). */
export const needsInstallationVariables = (plan: { pinned?: unknown } | undefined): boolean =>
  plan?.pinned !== undefined && JSON.stringify(plan.pinned).includes('{{');

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

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** Zones come from policy data; the memo stays bounded however many distinct ones appear. */
const MAX_ZONE_FORMATS = 64;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * `hour` and `weekday` for Cedar (10.3). UTC is computed arithmetically: building an `Intl.DateTimeFormat` per call (what
 * `clockContext` does) cost about 14% of the CPU of a proxied call. Other zones reuse one formatter each.
 */
export const wallClock = (nowMs: number, timeZone = 'UTC'): { hour: number; weekday: number } => {
  const date = new Date(nowMs);
  if (timeZone === 'UTC') return { hour: date.getUTCHours(), weekday: date.getUTCDay() };
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    });
    if (zoneFormats.size >= MAX_ZONE_FORMATS) zoneFormats.clear();
    zoneFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { hour, weekday: Math.max(weekday, 0) };
};

export const policyContextOf = (
  ctx: Pick<OpContext, 'principal' | 'clientInfo' | 'ip' | 'path'>,
  nowMs: number,
): McpRequestContext => ({
  clientId: ctx.principal.clientId ?? '',
  clientName: ctx.clientInfo?.name ?? '',
  ip: ctx.ip.length >= 2 ? ctx.ip : '0.0.0.0',
  authMethod: ctx.principal.authMethod,
  ...wallClock(nowMs),
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

/** The active span's context, or the request's own when no span is active (the ROOT fallback). */
export const spanContextOf = (ctx: Pick<OpContext, 'trace'>): SpanContext =>
  trace.getSpanContext(context.active()) ?? ctx.trace;

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
  trace: traceCarrierOf(spanContextOf(ctx)),
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

const logAllowed = (min: string | undefined, level: unknown): boolean => {
  if (min === undefined) return true;
  const minIndex = (LOGGING_LEVELS as readonly string[]).indexOf(min);
  const index =
    typeof level === 'string' ? (LOGGING_LEVELS as readonly string[]).indexOf(level) : -1;
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
  deps: Pick<OperationDeps, 'guards' | 'guardProfiles' | 'tracer' | 'clock'>,
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
  const started = deps.clock.now();
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
        [SPAN_ATTRS.guardInstance]: record.guard,
        [SPAN_ATTRS.guardPhase]: record.phase,
        [SPAN_ATTRS.guardVerdict]: record.verdict,
        [SPAN_ATTRS.guardAction]: record.action,
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

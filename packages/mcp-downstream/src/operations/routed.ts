/**
 * The routed pipeline shared by `tools/call`, `prompts/get` and `resources/read` (4.4): Cedar, limits, override
 * mapping (by the caller), request guards, upstream, response guards, limits feedback. MRTR rounds (6.5) are handled
 * here: answers Bastion can give itself loop upstream, everything else goes back to the adapter as `input_required`.
 */
import {
  ERROR_CODES,
  GuardBlockedError,
  MAX_INPUT_ROUNDS,
  PolicyDeniedError,
  QuotaExceededError,
  RateLimitedError,
  REQUEST_STATE_PREFIX,
  unwrapRequestState,
  wrapRequestState,
} from '@bastion-mcp/core';
import { extractStringLeaves, type ItemRef, type TextSegment } from '@bastion-mcp/guards';
import type { OperationContext } from '@bastion-mcp/limits';
import { clientSupports, type InputRequestMap } from '@bastion-mcp/mcp-upstream';
import type { ResourceData } from '@bastion-mcp/policy';
import type { InstallationInfo } from '@bastion-mcp/router';
import { SPAN_NAMES } from '@bastion-mcp/telemetry';
import { context, trace } from '@opentelemetry/api';
import { fullyLocal, partitionInputRequests } from '../bridge/partition';
import { byteSize, type CallRecord } from '../observability/call-log';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, OpContext, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import {
  applyGuardResult,
  bindingOf,
  callPrincipalOf,
  isRecord,
  policyContextOf,
  type RetryParts,
  remapProgress,
  runGuards,
  upstreamContextOf,
  withMeta,
  withSpan,
} from './support';

export const CONFIRM_KEY = 'confirm';
export const CONFIRM_MARKER = 'bastion:confirm:';

/** What a method contributes to the shared pipeline. */
export type RoutedSpec = {
  method: 'tools/call' | 'prompts/get' | 'resources/read';
  installation: InstallationInfo;
  /** Downstream final name or URI: the requestState binding and the call log use it. */
  downstreamName: string;
  upstreamName: string;
  toolName?: string | undefined;
  item: ItemRef;
  /** Cedar action and resource (10.3). The per-call arguments are attached for `callTool`. */
  policy: {
    action: 'callTool' | 'getPrompt' | 'readResource';
    resource: ResourceData;
    call?: JsonObject;
  };
  /** Request-phase content: segments addressed relative to `root`, and how to put the guarded root back. */
  request: {
    root: JsonObject;
    segments: TextSegment[];
    /** The upstream params (without the MRTR retry fields) built from the guarded root. */
    rebuild: (guarded: JsonObject) => JsonObject;
    /** The value bound into `requestState` (arguments, or the URI for reads). */
    bindArgs: (params: JsonObject) => unknown;
  };
  /** Response-phase segments of a complete result, addressed relative to the result. */
  responseSegments: (result: JsonObject) => TextSegment[];
  /** Override response mapping (`outputTransform`, `messagesTransform`), applied before the response guards (12.4). */
  transform?: ((result: JsonObject) => JsonObject) | undefined;
  /** Per-tool timeout from overrides (12.3). */
  timeoutMs?: number | undefined;
  guardProfileId?: string | null | undefined;
  /** Seen-URI indexing of results (7.4); tools only. */
  indexSeen?: ((result: JsonObject) => string[]) | undefined;
  /** Cached public reads (6.7). */
  readKey?: string | undefined;
};

const limitsPrincipal = (deps: OperationDeps, ctx: OpContext) => ({
  orgId: deps.settings.orgId,
  ...(ctx.principal.type === 'user'
    ? { userId: ctx.principal.id }
    : { serviceAccountId: ctx.principal.id }),
  teamIds: ctx.principal.teams.map((t) => t.teamId),
  roleIds: [ctx.principal.orgRole],
  ...(ctx.principal.clientId === null ? {} : { clientId: ctx.principal.clientId }),
});

const operationContextOf = (
  deps: OperationDeps,
  ctx: OpContext,
  spec: Pick<RoutedSpec, 'method' | 'installation' | 'toolName'>,
  amounts?: OperationContext['amounts'],
): OperationContext => ({
  principal: limitsPrincipal(deps, ctx),
  method: spec.method,
  installationId: spec.installation.id,
  catalogEntryId: spec.installation.catalogEntryId,
  ...(spec.toolName === undefined ? {} : { toolName: spec.toolName }),
  ...(amounts === undefined ? {} : { amounts }),
});

const endpointInfoOf = (ctx: OpContext) => ({
  installationIds: [...ctx.resolved.installations.keys()],
  catalogEntryIds: [...ctx.resolved.installations.values()].map((i) => i.catalogEntryId),
});

const attr = (key: string, value: string | undefined): void => {
  if (value !== undefined) trace.getActiveSpan()?.setAttribute(key, value);
};

const catalogEntryName = (i: InstallationInfo): string => i.catalogSlug ?? i.catalogEntryId;

const REFUNDABLE = new Set<number>([
  ERROR_CODES.UPSTREAM_UNAVAILABLE,
  ERROR_CODES.SANDBOX_START_FAILED,
]);

const confirmInputRequests = (reason: string): InputRequestMap => ({
  [CONFIRM_KEY]: {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: reason,
      requestedSchema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Approve this call' } },
        required: ['approve'],
      },
    },
  },
});

const approvedByUser = (responses: Record<string, unknown> | undefined): boolean => {
  const answer = responses?.[CONFIRM_KEY];
  if (!isRecord(answer) || answer.action !== 'accept') return false;
  return isRecord(answer.content) && answer.content.approve === true;
};

/** Counts sampling requests going to the client against the `samplingRequests` quota (6.5, 14.1). */
const chargeSampling = async (
  deps: OperationDeps,
  ctx: OpContext,
  spec: RoutedSpec,
  inputRequests: InputRequestMap,
): Promise<void> => {
  const count = Object.values(inputRequests).filter(
    (e) => e.method === 'sampling/createMessage',
  ).length;
  if (count === 0) return;
  const op = operationContextOf(deps, ctx, spec, { samplingRequests: count });
  const rules = deps.limitRules
    .rulesFor(op, endpointInfoOf(ctx))
    .filter((r) => r.metric === 'samplingRequests');
  if (rules.length === 0) return;
  const admission = await deps.limiter.check(op, rules, deps.newId());
  await admission.release();
};

const rootsOf = async (deps: OperationDeps, installationId: string): Promise<readonly string[]> => {
  const resolved = await deps.installations.get(installationId);
  return resolved?.roots ?? [];
};

export type RoutedResult = OpOutcome<JsonObject>;

/** Runs the pipeline. Errors propagate; the caller converts and records them. */
export const runRouted = async (
  deps: OperationDeps,
  ctx: OpContext,
  spec: RoutedSpec,
  retry: RetryParts,
  record: CallRecord,
): Promise<RoutedResult> => {
  const { installation } = spec;
  record.installationId = installation.id;
  record.catalogEntryId = installation.catalogEntryId;
  record.catalogVersionId = installation.catalogVersionId;
  record.itemName = spec.downstreamName;
  record.upstreamName = spec.upstreamName;
  attr('bastion.installation.id', installation.id);
  attr('bastion.installation.slug', installation.slug);
  attr('bastion.catalog.entry', catalogEntryName(installation));
  attr('bastion.catalog.version', installation.catalogVersionId);

  // 1. Cedar (4.4)
  const profile = deps.profiles ? await deps.profiles.profile(ctx.principal) : {};
  const decision = await withSpan(
    deps,
    SPAN_NAMES.policy,
    { 'bastion.policy.action': spec.policy.action },
    async (span) => {
      const result = deps.policy.current().authorize({
        principal: deps.toPolicyPrincipal(ctx.principal, profile),
        action: spec.policy.action,
        resource: spec.policy.resource,
        context: policyContextOf(ctx, deps.clock.now()),
        ...(spec.policy.call === undefined ? {} : { call: spec.policy.call }),
      });
      span.setAttribute('bastion.policy.decision', result.decision);
      return result;
    },
  );
  record.policyReasons = decision.reasons;
  attr('bastion.policy.decision', decision.decision);
  if (decision.decision === 'deny') {
    throw new PolicyDeniedError(
      `You are not allowed to ${spec.method === 'tools/call' ? 'call' : 'use'} ${spec.downstreamName}.`,
      { reason: 'denied by policy', policyIds: decision.reasons },
    );
  }

  // 2. Limits (14.2)
  const op = operationContextOf(deps, ctx, spec);
  const requestId = deps.newId();
  const admission = await withSpan(deps, SPAN_NAMES.limits, {}, async () => {
    try {
      return await deps.limiter.check(
        op,
        deps.limitRules.rulesFor(op, endpointInfoOf(ctx)),
        requestId,
      );
    } catch (error) {
      if (error instanceof RateLimitedError || error instanceof QuotaExceededError) {
        deps.metrics.limitsRejections.add(1, {
          rule: String(error.data.limit ?? error.data.quota ?? 'unknown'),
          kind:
            error instanceof QuotaExceededError
              ? 'quota'
              : error.message.startsWith('Concurrency')
                ? 'concurrency'
                : 'rate',
        });
      }
      throw error;
    }
  });
  try {
    return await afterAdmission(deps, ctx, spec, retry, record, admission.meta);
  } catch (error) {
    const code = (error as { mcpCode?: number }).mcpCode;
    if (code !== undefined && REFUNDABLE.has(code)) await admission.refund();
    throw error;
  } finally {
    await admission.release();
  }
};

const afterAdmission = async (
  deps: OperationDeps,
  ctx: OpContext,
  spec: RoutedSpec,
  retry: RetryParts,
  record: CallRecord,
  limitsMeta: Record<string, unknown> | undefined,
): Promise<RoutedResult> => {
  const { installation } = spec;

  // 4. Request guards (13.1): arguments (or URI) and, on retries, the inputResponses text.
  const forUpstream = retry.requestState !== undefined && retry.inputResponses !== undefined;
  const segments: TextSegment[] = [...spec.request.segments];
  if (retry.inputResponses !== undefined) {
    segments.push(...extractStringLeaves(retry.inputResponses, 'inputResponses'));
  }
  const root: JsonObject = {
    ...spec.request.root,
    ...(retry.inputResponses === undefined ? {} : { inputResponses: retry.inputResponses }),
  };
  const guardRun = await runGuards(
    deps,
    ctx,
    'request',
    { installation, item: spec.item, method: spec.method },
    segments,
    spec.guardProfileId,
  );
  record.guardResults.push(...guardRun.records);
  const applied = applyGuardResult(guardRun, root, segments);
  const guardedRoot = applied.value as JsonObject;
  const { inputResponses: guardedResponses, ...guardedRequest } = guardedRoot;
  const upstreamParams = spec.request.rebuild(guardedRequest);
  record.bytesIn = byteSize(spec.request.bindArgs(upstreamParams));
  record.argsPreview = spec.request.bindArgs(upstreamParams);

  const binding = bindingOf(
    ctx,
    installation.id,
    spec.method,
    spec.downstreamName,
    spec.request.bindArgs(upstreamParams),
  );
  const nowSeconds = Math.floor(deps.clock.now() / 1000);
  let confirmApproved = false;
  let stripRetry = false;
  if (retry.requestState !== undefined) {
    if (!retry.requestState.startsWith(REQUEST_STATE_PREFIX)) {
      throw new InvalidParamsError('invalid requestState');
    }
    const state = unwrapRequestState(deps.stateKeyring, retry.requestState, binding, {
      now: nowSeconds,
    });
    if (state.upstreamState?.startsWith(CONFIRM_MARKER)) {
      // Bastion's own approval round: nothing of it goes upstream (13.2).
      stripRetry = true;
      confirmApproved = approvedByUser(guardedResponses as Record<string, unknown> | undefined);
      if (!confirmApproved) {
        throw new GuardBlockedError(`The call to ${spec.downstreamName} was not approved.`, {
          guard: state.upstreamState.slice(CONFIRM_MARKER.length),
          ruleId: 'confirm',
        });
      }
    }
  } else if (retry.inputResponses !== undefined) {
    throw new InvalidParamsError('requestState is required with inputResponses');
  }

  // `confirm` (13.2): approval through a form elicitation, blocked when the client cannot elicit or declines.
  if (guardRun.confirm && !confirmApproved) {
    const reason = guardRun.confirm.reason;
    if (!clientSupports(ctx.clientCapabilities, 'elicitation', { mode: 'form' })) {
      throw new GuardBlockedError(
        `${spec.downstreamName} needs your approval (${reason}) but your client cannot ask for it.`,
        { guard: guardRun.confirm.guard, ruleId: 'confirm' },
      );
    }
    record.outcome = 'input_required';
    return {
      kind: 'input_required',
      inputRequests: confirmInputRequests(`${reason}. Approve ${spec.downstreamName}?`),
      requestState: wrapRequestState(deps.stateKeyring, binding, {
        now: nowSeconds,
        upstreamState: `${CONFIRM_MARKER}${guardRun.confirm.guard}`,
      }),
      installationId: installation.id,
    };
  }

  // Cached public reads (6.7)
  if (spec.readKey !== undefined && !forUpstream && deps.reads) {
    const cached = await deps.reads.get(installation.id, spec.readKey);
    if (isRecord(cached))
      return finishComplete(deps, ctx, spec, record, cached, applied.meta, limitsMeta);
  }

  // 5. Upstream, looping while Bastion can answer the input requests itself (6.5)
  const principal = await callPrincipalOf(deps, ctx);
  const progress = remapProgress(ctx, deps.newId);
  const deadlineAt = spec.timeoutMs === undefined ? undefined : deps.clock.now() + spec.timeoutMs;
  const uctx = upstreamContextOf(ctx, principal, installation.id, {
    downstreamName: spec.downstreamName,
    deadlineAt,
    emit: progress.emit,
  });
  let params: JsonObject = {
    ...upstreamParams,
    ...(progress.upstreamMeta === undefined ? {} : { _meta: progress.upstreamMeta }),
    ...(retry.requestState !== undefined && !stripRetry
      ? { requestState: retry.requestState, inputResponses: guardedResponses ?? {} }
      : {}),
  };
  for (let round = 0; round < MAX_INPUT_ROUNDS; round += 1) {
    const outcome = await deps.upstream.execute({
      installationId: installation.id,
      method: spec.method,
      params,
      ctx: uctx,
    });
    if (outcome.kind === 'task') return { kind: 'task', task: outcome.task as JsonObject };
    if (outcome.kind === 'complete') {
      const result = isRecord(outcome.result) ? outcome.result : {};
      if (spec.readKey !== undefined && deps.reads) {
        await deps.reads.put(installation.id, spec.readKey, result).catch(() => false);
      }
      return finishComplete(deps, ctx, spec, record, result, applied.meta, limitsMeta);
    }
    // input_required: response-phase guards on the text the client would see (13.1)
    const inputRequests = outcome.inputRequests ?? {};
    const inputSegments = extractStringLeaves(inputRequests, 'inputRequests');
    const inputRun = await runGuards(
      deps,
      ctx,
      'response',
      { installation, item: spec.item, method: spec.method },
      inputSegments,
      spec.guardProfileId,
    );
    record.guardResults.push(...inputRun.records);
    const guardedInput = applyGuardResult(inputRun, { inputRequests }, inputSegments);
    const checked = (guardedInput.value as { inputRequests: InputRequestMap }).inputRequests;
    const partition = partitionInputRequests(
      checked,
      ctx.clientCapabilities,
      await rootsOf(deps, installation.id),
    );
    if (fullyLocal(partition) && Object.keys(checked).length > 0) {
      params = { ...params, inputResponses: partition.local, requestState: outcome.requestState };
      continue;
    }
    await chargeSampling(deps, ctx, spec, partition.forClient);
    record.outcome = 'input_required';
    return {
      kind: 'input_required',
      inputRequests: checked,
      requestState: outcome.requestState,
      installationId: installation.id,
    };
  }
  throw new InvalidParamsError('too many input rounds');
};

const finishComplete = async (
  deps: OperationDeps,
  ctx: OpContext,
  spec: RoutedSpec,
  record: CallRecord,
  upstreamResult: JsonObject,
  requestMeta: Record<string, unknown>,
  limitsMeta: Record<string, unknown> | undefined,
): Promise<RoutedResult> => {
  const transformed = spec.transform ? spec.transform(upstreamResult) : upstreamResult;
  const segments = spec.responseSegments(transformed);
  const run = await runGuards(
    deps,
    ctx,
    'response',
    { installation: spec.installation, item: spec.item, method: spec.method },
    segments,
    spec.guardProfileId,
  );
  record.guardResults.push(...run.records);
  if (run.confirm && !run.block) {
    // The result cannot be held across an approval round without server-side storage: block (safe default, 13.2).
    throw new GuardBlockedError(
      `The result of ${spec.downstreamName} needs approval (${run.confirm.reason}) and was withheld.`,
      { guard: run.confirm.guard, ruleId: 'confirm' },
    );
  }
  const guarded = applyGuardResult(run, transformed, segments);
  let result = guarded.value as JsonObject;
  result = withMeta(result, { ...requestMeta, ...guarded.meta, ...(limitsMeta ?? {}) });
  if (spec.indexSeen) {
    const uris = spec.indexSeen(result);
    if (uris.length > 0) {
      await deps.seenUris
        .record(
          ctx.principal.id,
          ctx.endpoint.endpointId,
          uris.map((uri) => ({ uri, installationId: spec.installation.id })),
        )
        .catch((error: unknown) =>
          deps.logger.warn('could not index seen URIs', { error: String(error) }),
        );
    }
  }
  record.bytesOut = byteSize(result);
  record.resultPreview = result;
  if (spec.method === 'tools/call' && result.isError === true) record.outcome = 'tool_error';
  return { kind: 'complete', result };
};

export { context };

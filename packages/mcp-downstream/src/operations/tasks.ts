/** `tasks/get`, `tasks/update`, `tasks/cancel` (6.8): routed by the wrapped `btk1.` id, guards on what flows through. */
import { type TaskIdPayload, unwrapTaskId } from '@bastion-mcp/mcp-upstream';
import { extractStringLeaves, type TextSegment } from '@bastion-mcp/guards';
import { extractResultSegments } from '@bastion-mcp/guards';
import { trace } from '@opentelemetry/api';
import { CallRecord, byteSize } from '../observability/call-log';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { recordOperationOutcome } from './outcome';
import {
  applyGuardResult,
  callPrincipalOf,
  isRecord,
  runGuards,
  upstreamContextOf,
  withMeta,
} from './support';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

type TaskMethod = 'tasks/get' | 'tasks/update' | 'tasks/cancel';

const prefixed = (segments: TextSegment[], prefix: string): TextSegment[] =>
  segments.map((s) => ({ ...s, path: `${prefix}.${s.path}` }));

const taskOperation = (deps: OperationDeps, method: TaskMethod): Operation => ({
  method,
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const taskId = params.taskId;
    if (typeof taskId !== 'string' || taskId === '') throw new InvalidParamsError('taskId is required');
    // Verifies the AEAD token, the principal and the expiry; throws -32602 otherwise (22.1).
    const payload: TaskIdPayload = unwrapTaskId(
      deps.stateKeyring,
      taskId,
      ctx.principal.id,
      Math.floor(deps.clock.now() / 1000),
    );
    const installation = ctx.resolved.installations.get(payload.i);
    // A task of an installation this endpoint does not serve looks like any invalid id.
    if (!installation) throw new InvalidParamsError('invalid taskId');
    const record = new CallRecord(method, deps.clock.now());
    const span = trace.getActiveSpan()?.spanContext() ?? ctx.trace;
    record.installationId = installation.id;
    record.catalogEntryId = installation.catalogEntryId;
    record.catalogVersionId = installation.catalogVersionId;
    record.itemName = taskId.slice(0, 12);
    const subject = { installation, item: { kind: 'tool' as const, name: 'task' }, method };
    try {
      let sendParams: JsonObject = { ...params };
      if (isRecord(params.inputResponses)) {
        // inputResponses sent with tasks/update pass the request guards (6.8).
        const segments = extractStringLeaves(params.inputResponses, 'inputResponses');
        const run = await runGuards(deps, ctx, 'request', subject, segments);
        record.guardResults.push(...run.records);
        const applied = applyGuardResult(run, { inputResponses: params.inputResponses }, segments);
        sendParams = { ...sendParams, ...(applied.value as JsonObject) };
      }
      const principal = await callPrincipalOf(deps, ctx);
      const outcome = await deps.upstream.executeTask({
        method,
        params: sendParams,
        ctx: upstreamContextOf(ctx, principal, installation.id, { downstreamName: taskId }),
      });
      if (outcome.kind !== 'complete') throw new InvalidParamsError('unexpected task outcome');
      let result = isRecord(outcome.result) ? outcome.result : {};
      if (method === 'tasks/get') result = await guardTaskResult(deps, ctx, subject, record, result);
      const status = typeof result.status === 'string' ? result.status : undefined;
      record.bytesOut = byteSize(result);
      // One row per task with its final status (6.8).
      record.resultPreview = { taskStatus: status };
      if (status === 'failed') record.outcome = 'error';
      if (status !== undefined && !TERMINAL.has(status) && method === 'tasks/get') record.skipLog = true;
      return { kind: 'complete', result };
    } catch (error) {
      record.fail(error);
      throw error;
    } finally {
      if (!record.skipLog) recordOperationOutcome(deps, ctx, record, span, installation, method);
    }
  },
});

/** Response guards on the terminal `result` and on task `inputRequests` returned by `tasks/get` (6.8). */
const guardTaskResult = async (
  deps: OperationDeps,
  ctx: OpContext,
  subject: { installation: import('@bastion-mcp/router').InstallationInfo; item: { kind: 'tool'; name: string }; method: string },
  record: CallRecord,
  result: JsonObject,
): Promise<JsonObject> => {
  const inner = isRecord(result.result) ? result.result : undefined;
  const segments: TextSegment[] = [
    ...(inner ? prefixed(extractResultSegments(inner), 'result') : []),
    ...(result.inputRequests === undefined
      ? []
      : extractStringLeaves(result.inputRequests, 'inputRequests')),
  ];
  if (segments.length === 0) return result;
  const run = await runGuards(deps, ctx, 'response', subject, segments);
  record.guardResults.push(...run.records);
  const applied = applyGuardResult(run, result, segments);
  return withMeta(applied.value as JsonObject, applied.meta);
};

export const createTaskGet = (deps: OperationDeps): Operation => taskOperation(deps, 'tasks/get');
export const createTaskUpdate = (deps: OperationDeps): Operation => taskOperation(deps, 'tasks/update');
export const createTaskCancel = (deps: OperationDeps): Operation => taskOperation(deps, 'tasks/cancel');

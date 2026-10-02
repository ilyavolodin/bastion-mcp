/** `skills/list`, `skills/get` (6.8, 25.8) and verbatim forwarding of unknown methods on single-installation endpoints (6.3). */
import { trace } from '@opentelemetry/api';
import { byteSize, CallRecord } from '../observability/call-log';
import { InvalidParamsError, MethodNotFoundError, UnknownItemError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { recordOperationOutcome } from './outcome';
import {
  callPrincipalOf,
  isRecord,
  isSingleInstallationEndpoint,
  upstreamContextOf,
} from './support';

const singleInstallationId = (ctx: OpContext): string | undefined => {
  if (!isSingleInstallationEndpoint(ctx)) return undefined;
  return ctx.resolved.definition.installationIds?.[0] ?? [...ctx.resolved.installations.keys()][0];
};

/** Forwards `method` to the installation of a single-installation endpoint; used by skills and unknown methods. */
export const forwardToInstallation = async (
  deps: OperationDeps,
  ctx: OpContext,
  method: string,
  params: JsonObject,
): Promise<OpOutcome<JsonObject>> => {
  const installationId = singleInstallationId(ctx);
  const installation = installationId ? ctx.resolved.installations.get(installationId) : undefined;
  if (!installation) throw new MethodNotFoundError(method);
  const record = new CallRecord(method, deps.clock.now());
  const span = trace.getActiveSpan()?.spanContext() ?? ctx.trace;
  record.installationId = installation.id;
  record.catalogEntryId = installation.catalogEntryId;
  record.catalogVersionId = installation.catalogVersionId;
  try {
    const principal = await callPrincipalOf(deps, ctx);
    const outcome = await deps.upstream.execute({
      installationId: installation.id,
      method,
      params,
      ctx: upstreamContextOf(ctx, principal, installation.id, { downstreamName: method }),
    });
    if (outcome.kind === 'task') return { kind: 'task', task: outcome.task as JsonObject };
    if (outcome.kind === 'input_required') {
      record.outcome = 'input_required';
      return {
        kind: 'input_required',
        inputRequests: outcome.inputRequests,
        requestState: outcome.requestState,
        installationId: installation.id,
      };
    }
    const result = isRecord(outcome.result) ? outcome.result : {};
    record.bytesOut = byteSize(result);
    return { kind: 'complete', result };
  } catch (error) {
    record.fail(error);
    throw error;
  } finally {
    recordOperationOutcome(deps, ctx, record, span, installation, method);
  }
};

export const createForward = (deps: OperationDeps, method: string): Operation => ({
  method,
  run: (params, ctx) => forwardToInstallation(deps, ctx, method, params),
});

const skillsOf = (value: unknown): unknown[] =>
  isRecord(value) && Array.isArray(value.skills) ? value.skills : [];

export const createSkillsList = (deps: OperationDeps): Operation => ({
  method: 'skills/list',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const hosted = deps.skills ? await deps.skills.list(ctx.principal) : { skills: [] };
    const merged: unknown[] = [...skillsOf(hosted)];
    if (singleInstallationId(ctx) !== undefined) {
      try {
        const upstream = await forwardToInstallation(deps, ctx, 'skills/list', params);
        if (upstream.kind === 'complete') merged.push(...skillsOf(upstream.result));
      } catch (error) {
        deps.logger.warn('upstream skills/list failed', { error: String(error) });
      }
    }
    return { kind: 'complete', result: { ...hosted, skills: merged } };
  },
});

export const createSkillsGet = (deps: OperationDeps): Operation => ({
  method: 'skills/get',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const ref =
      typeof params.uri === 'string'
        ? { uri: params.uri }
        : typeof params.plugin === 'string' && typeof params.name === 'string'
          ? { plugin: params.plugin, name: params.name }
          : undefined;
    if (!ref) throw new InvalidParamsError('uri or plugin and name are required');
    const hosted = deps.skills ? await deps.skills.get(ctx.principal, ref) : undefined;
    if (hosted) return { kind: 'complete', result: hosted };
    if (singleInstallationId(ctx) !== undefined) {
      return forwardToInstallation(deps, ctx, 'skills/get', params);
    }
    throw new UnknownItemError('resource', 'uri' in ref ? ref.uri : `${ref.plugin}/${ref.name}`);
  },
});

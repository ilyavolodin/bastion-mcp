/** `resources/subscribe` and `resources/unsubscribe` (legacy only, 6.3, 6.6), and `logging/setLevel`. */
import { PolicyDeniedError } from '@bastion-mcp/core';
import { ResourceNotFoundError, resolveResourceUriWithSeen } from '@bastion-mcp/router';
import { trace } from '@opentelemetry/api';
import { CallRecord } from '../observability/call-log';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, LoggingLevel, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { recordOperationOutcome } from './outcome';
import { callPrincipalOf, installationDataOf, policyContextOf } from './support';

const subscription = (deps: OperationDeps, method: 'resources/subscribe' | 'resources/unsubscribe'): Operation => ({
  method,
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const uri = params.uri;
    if (typeof uri !== 'string' || uri === '') throw new InvalidParamsError('uri is required');
    const target = await resolveResourceUriWithSeen(ctx.endpoint.uriIndex, uri, {
      store: deps.seenUris,
      principalId: ctx.principal.id,
      endpointId: ctx.endpoint.endpointId,
    });
    if (!target.ok) throw new ResourceNotFoundError(uri);
    const installation = ctx.resolved.installations.get(target.target.installationId);
    if (!installation) throw new ResourceNotFoundError(uri);
    const record = new CallRecord(method, deps.clock.now());
    const span = trace.getActiveSpan()?.spanContext() ?? ctx.trace;
    record.installationId = installation.id;
    record.catalogEntryId = installation.catalogEntryId;
    record.catalogVersionId = installation.catalogVersionId;
    record.itemName = uri;
    try {
      if (method === 'resources/subscribe') {
        const profile = deps.profiles ? await deps.profiles.profile(ctx.principal) : {};
        const decision = deps.policy.current().authorize({
          principal: deps.toPolicyPrincipal(ctx.principal, profile),
          action: 'subscribeResource',
          resource: { type: 'Resource', installation: installationDataOf(installation), uri },
          context: policyContextOf(ctx, deps.clock.now()),
        });
        record.policyReasons = decision.reasons;
        if (decision.decision === 'deny') {
          throw new PolicyDeniedError('You are not allowed to subscribe to this resource.', {
            reason: 'denied by policy',
            policyIds: decision.reasons,
          });
        }
      }
      const args = {
        installationId: installation.id,
        principal: await callPrincipalOf(deps, ctx),
        downstreamUri: uri,
        endpointId: ctx.endpoint.endpointId,
        signal: ctx.signal,
      };
      if (method === 'resources/subscribe') await deps.upstream.subscribeResource(args);
      else await deps.upstream.unsubscribeResource(args);
      return { kind: 'complete', result: {} };
    } catch (error) {
      record.fail(error);
      throw error;
    } finally {
      recordOperationOutcome(deps, ctx, record, span, installation, method);
    }
  },
});

export const createResourceSubscribe = (deps: OperationDeps): Operation =>
  subscription(deps, 'resources/subscribe');
export const createResourceUnsubscribe = (deps: OperationDeps): Operation =>
  subscription(deps, 'resources/unsubscribe');

export const LOGGING_LEVELS: readonly LoggingLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

/**
 * `logging/setLevel` (legacy only): answered locally. The adapter stores the level on the session; Bastion sends it
 * upstream as the per-request `_meta` level (6.3).
 */
export const createSetLevel = (): Operation => ({
  method: 'logging/setLevel',
  async run(params: JsonObject): Promise<OpOutcome<JsonObject>> {
    const level = params.level;
    if (typeof level !== 'string' || !(LOGGING_LEVELS as readonly string[]).includes(level)) {
      throw new InvalidParamsError('level must be a logging level');
    }
    return { kind: 'complete', result: {} };
  },
});

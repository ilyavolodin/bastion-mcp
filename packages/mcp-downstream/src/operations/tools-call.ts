/** `tools/call` (4.4, 6.9): resolve the name, run the routed pipeline, convert denials into tool results. */
import { isBastionError, toToolErrorResult } from '@bastion-mcp/core';
import { extractRequestSegments, extractResultSegments } from '@bastion-mcp/guards';
import { applyOutputTransform, type JsonValue, mapToolCall } from '@bastion-mcp/overrides';
import { extractSeenUris } from '@bastion-mcp/router';
import { trace } from '@opentelemetry/api';
import { CallRecord } from '../observability/call-log';
import { InvalidParamsError, UnknownItemError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { recordOperationOutcome } from './outcome';
import { runRouted } from './routed';
import {
  callPrincipalOf,
  installationDataOf,
  isRecord,
  retryParts,
  templateContextOf,
  toolAnnotationsOf,
  toolDefinition,
} from './support';

export const createToolsCall = (deps: OperationDeps): Operation => ({
  method: 'tools/call',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const name = params.name;
    if (typeof name !== 'string' || name === '') throw new InvalidParamsError('name is required');
    const args = params.arguments;
    if (args !== undefined && !isRecord(args)) {
      throw new InvalidParamsError('arguments must be an object');
    }
    const route = ctx.endpoint.toolRoutes.get(name);
    // Hidden and nonexistent are the same answer (6.9).
    const installation = route ? ctx.resolved.installations.get(route.installationId) : undefined;
    if (!route || !installation) throw new UnknownItemError('tool', name);
    const retry = retryParts(params);
    const record = new CallRecord('tools/call', deps.clock.now());
    const span = trace.getActiveSpan()?.spanContext() ?? ctx.trace;
    try {
      const principal = await callPrincipalOf(deps, ctx);
      const resolved =
        route.plan?.pinned && JSON.stringify(route.plan.pinned).includes('{{')
          ? await deps.installations.get(installation.id)
          : null;
      const mapped = mapToolCall(
        { finalName: name, arguments: (args ?? {}) as Record<string, JsonValue> },
        { upstreamName: route.upstreamName, plan: route.plan },
        templateContextOf(principal, resolved?.variables),
      );
      record.upstreamName = route.upstreamName;
      record.itemName = name;
      if (!mapped.ok) {
        record.outcome = 'tool_error';
        record.installationId = installation.id;
        return { kind: 'complete', result: mapped.result };
      }
      const upstreamArgs = mapped.arguments as JsonObject;
      const tool = toolDefinition(ctx.endpoint, name);
      const outcome = await runRouted(
        deps,
        ctx,
        {
          method: 'tools/call',
          installation,
          downstreamName: name,
          upstreamName: mapped.upstreamName,
          toolName: name,
          item: {
            kind: 'tool',
            name,
            ...(tool?.annotations &&
            isRecord(tool.annotations) &&
            tool.annotations.destructiveHint === true
              ? { destructive: true }
              : {}),
            ...(tool?.annotations &&
            isRecord(tool.annotations) &&
            tool.annotations.openWorldHint === true
              ? { openWorld: true }
              : {}),
          },
          policy: {
            action: 'callTool',
            resource: {
              type: 'Tool',
              installation: installationDataOf(installation),
              name,
              annotations: toolAnnotationsOf(tool),
            },
            call: (args ?? {}) as JsonObject,
          },
          request: {
            root: { arguments: upstreamArgs },
            segments: extractRequestSegments(upstreamArgs, 'arguments'),
            rebuild: (guarded) => ({ name: mapped.upstreamName, arguments: guarded.arguments }),
            bindArgs: (p) => p.arguments ?? {},
          },
          responseSegments: (result) => extractResultSegments(result),
          transform: (result) => applyOutputTransform(result, mapped.outputTransform),
          timeoutMs: mapped.timeoutMs,
          guardProfileId: mapped.guardProfileId,
          indexSeen: (result) => extractSeenUris(result),
        },
        retry,
        record,
      );
      return outcome;
    } catch (error) {
      record.fail(error);
      if (isBastionError(error) && error.isToolResult) {
        // POLICY_DENIED, RATE_LIMITED, QUOTA_EXCEEDED and GUARD_BLOCKED are results the model can read (6.9).
        return { kind: 'complete', result: toToolErrorResult(error) };
      }
      throw error;
    } finally {
      recordOperationOutcome(deps, ctx, record, span, installation, 'tools/call');
    }
  },
});

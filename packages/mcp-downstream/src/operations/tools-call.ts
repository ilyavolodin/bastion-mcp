/** `tools/call` (4.4, 6.9): resolve the name, run the routed pipeline, convert denials into tool results. */
import { isBastionError, toToolErrorResult } from '@bastion-mcp/core';
import { extractRequestSegments, extractResultSegments } from '@bastion-mcp/guards';
import { applyOutputTransform, type JsonValue, mapToolCall } from '@bastion-mcp/overrides';
import { extractSeenUris } from '@bastion-mcp/router';
import { InvalidParamsError, UnknownItemError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { runRoutedOperation } from './outcome';
import { runRouted } from './routed';
import {
  callPrincipalOf,
  installationDataOf,
  isRecord,
  needsInstallationVariables,
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
    return runRoutedOperation(
      deps,
      ctx,
      'tools/call',
      installation,
      async (record) => {
        const principal = await callPrincipalOf(deps, ctx);
        const resolved = needsInstallationVariables(route.plan)
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
          return { kind: 'complete', result: mapped.result };
        }
        const upstreamArgs = mapped.arguments as JsonObject;
        const tool = toolDefinition(ctx.endpoint, name);
        const hints = toolAnnotationsOf(tool);
        return runRouted(
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
              ...(hints.destructiveHint === true ? { destructive: true } : {}),
              ...(hints.openWorldHint === true ? { openWorld: true } : {}),
            },
            policy: {
              action: 'callTool',
              resource: {
                type: 'Tool',
                installation: installationDataOf(installation),
                name,
                annotations: hints,
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
      },
      {
        // POLICY_DENIED, RATE_LIMITED, QUOTA_EXCEEDED and GUARD_BLOCKED are results the model can read (6.9).
        onError: (error) =>
          isBastionError(error) && error.isToolResult
            ? { kind: 'complete', result: toToolErrorResult(error) }
            : undefined,
      },
    );
  },
});

/** `prompts/get` (6.3): routed like a tool call, with prompt arguments and `messagesTransform` (12.4). */
import { extractPromptSegments, extractRequestSegments } from '@bastion-mcp/guards';
import {
  addedPromptResult,
  applyMessagesTransform,
  mapPromptGet,
  missingPromptArguments,
} from '@bastion-mcp/overrides';
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
} from './support';

const stringArguments = (value: unknown): Record<string, string> => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new InvalidParamsError('arguments must be an object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new InvalidParamsError(`argument ${k} must be a string`);
    out[k] = v;
  }
  return out;
};

export const createPromptsGet = (deps: OperationDeps): Operation => ({
  method: 'prompts/get',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const name = params.name;
    if (typeof name !== 'string' || name === '') throw new InvalidParamsError('name is required');
    const args = stringArguments(params.arguments);
    const route = ctx.endpoint.promptRoutes.get(name);
    const installation = route ? ctx.resolved.installations.get(route.installationId) : undefined;
    if (!route || !installation) throw new UnknownItemError('prompt', name);
    const retry = retryParts(params);
    return runRoutedOperation(deps, ctx, 'prompts/get', installation, async (record) => {
      const principal = await callPrincipalOf(deps, ctx);
      const resolved = needsInstallationVariables(route.plan)
        ? await deps.installations.get(installation.id)
        : null;
      const mapped = mapPromptGet(
        { finalName: name, arguments: args },
        { upstreamName: route.upstreamName, plan: route.plan },
        templateContextOf(principal, resolved?.variables),
      );
      if (!mapped.ok) throw new InvalidParamsError(mapped.error);
      const hosted = route.hosted;
      if (hosted) {
        const missing = missingPromptArguments(hosted, mapped.arguments);
        if (missing.length > 0) {
          throw new InvalidParamsError(`missing required argument: ${missing.join(', ')}`);
        }
      }
      return runRouted(
        deps,
        ctx,
        {
          method: 'prompts/get',
          installation,
          downstreamName: name,
          upstreamName: mapped.upstreamName,
          item: { kind: 'prompt', name },
          policy: {
            action: 'getPrompt',
            resource: { type: 'Prompt', installation: installationDataOf(installation), name },
          },
          request: {
            root: { arguments: mapped.arguments },
            segments: extractRequestSegments(mapped.arguments, 'arguments'),
            rebuild: (guarded) => ({ name: mapped.upstreamName, arguments: guarded.arguments }),
            bindArgs: (p) => p.arguments ?? {},
          },
          responseSegments: (result) => extractPromptSegments(result.messages),
          ...(hosted
            ? {
                local: (p: JsonObject) =>
                  addedPromptResult(hosted, stringArguments(p.arguments)) as unknown as JsonObject,
              }
            : {}),
          transform: (result) =>
            Array.isArray(result.messages)
              ? applyMessagesTransform(
                  result as { messages: never[] } & JsonObject,
                  mapped.messagesTransform,
                )
              : result,
        },
        retry,
        record,
      );
    });
  },
});

/** The operation registry (6.3) and the runner that adds spans, metrics and unknown-method handling (15.2, 15.3). */
import type { OpRunner } from '../adapters/contracts';
import { errorTypeOf, MethodNotFoundError } from '../rpc';
import type { JsonObject, OpContext, Operation, OperationRegistry, OpOutcome } from '../types';
import {
  createDiscover,
  createInitialize,
  createInitialized,
  createList,
  createPing,
  LIST_METHODS,
} from './basic';
import { createCompletion } from './completion';
import type { OperationDeps } from './deps';
import { createPromptsGet } from './prompts-get';
import { createResourcesRead } from './resources-read';
import { createForward, createSkillsGet, createSkillsList } from './skills';
import {
  createResourceSubscribe,
  createResourceUnsubscribe,
  createSetLevel,
} from './subscriptions';
import { createTaskCancel, createTaskGet, createTaskUpdate } from './tasks';
import { createToolsCall } from './tools-call';
import { downstreamMcpSpan } from '@bastion-mcp/telemetry';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/** Every method of the 6.3 table that Bastion serves through the operation layer. */
export const createOperations = (deps: OperationDeps): OperationRegistry => {
  const list: Operation[] = [
    createInitialize(deps),
    createInitialized(),
    createDiscover(deps),
    createPing(),
    ...LIST_METHODS.map((m) => createList(deps, m)),
    createToolsCall(deps),
    createPromptsGet(deps),
    createResourcesRead(deps),
    createCompletion(deps),
    createResourceSubscribe(deps),
    createResourceUnsubscribe(deps),
    createSetLevel(),
    createTaskGet(deps),
    createTaskUpdate(deps),
    createTaskCancel(deps),
    createSkillsList(deps),
    createSkillsGet(deps),
  ];
  const byMethod = new Map(list.map((op) => [op.method, op]));
  return { get: (method) => byMethod.get(method), methods: [...byMethod.keys()] };
};

const nameOf = (method: string, params: JsonObject): { tool?: string; prompt?: string; uri?: string } => {
  if (method === 'tools/call' && typeof params.name === 'string') return { tool: params.name };
  if (method === 'prompts/get' && typeof params.name === 'string') return { prompt: params.name };
  if (method.startsWith('resources/') && typeof params.uri === 'string') return { uri: params.uri };
  return {};
};

/**
 * Runs one operation by method name as a SERVER span `{method} {target}` with the full attribute set (15.2) and records
 * `mcp.server.operation.duration` (15.3). Unknown methods are forwarded verbatim on single-installation endpoints and
 * answer `-32601` elsewhere (6.3).
 */
export const createOpRunner = (
  deps: OperationDeps,
  registry: OperationRegistry,
): OpRunner => {
  return async (method: string, params: JsonObject, ctx: OpContext): Promise<OpOutcome<unknown>> => {
    const started = performance.now();
    const target = nameOf(method, params);
    const descriptor = downstreamMcpSpan({
      method,
      toolName: target.tool,
      promptName: target.prompt,
      resourceUri: target.uri,
      protocolVersion: ctx.protocolVersion,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      principalId: ctx.principal.id,
      principalType: ctx.principal.type,
      clientId: ctx.principal.clientId ?? undefined,
      clientName: ctx.clientInfo?.name,
      endpointId: ctx.endpoint.endpointId,
      eraDownstream: ctx.era,
      clientAddress: ctx.ip,
      networkTransport: 'tcp',
      captureContent: deps.settings.captureContent,
      toolArguments: params.arguments,
    });
    const parent = trace.setSpanContext(context.active(), ctx.trace);
    const span = deps.tracer.startSpan(
      descriptor.name,
      { kind: SpanKind.SERVER, attributes: descriptor.attributes },
      parent,
    );
    const active = trace.setSpan(parent, span);
    const spanContext = span.spanContext();
    const traced: OpContext = { ...ctx, trace: spanContext };
    let errorType: string | undefined;
    try {
      return await context.with(active, async () => {
        const op = registry.get(method) ?? (isRequestLike(method) ? createForward(deps, method) : undefined);
        if (!op) throw new MethodNotFoundError(method);
        const outcome = await op.run(params, traced);
        if (deps.settings.captureContent && outcome.kind === 'complete' && method === 'tools/call') {
          span.setAttribute('gen_ai.tool.call.result', safeJson(outcome.result));
        }
        return outcome;
      });
    } catch (error) {
      errorType = errorTypeOf(error);
      span.setAttribute('error.type', errorType);
      const code = (error as { mcpCode?: number }).mcpCode;
      if (code !== undefined) span.setAttribute('rpc.response.status_code', String(code));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
      throw error;
    } finally {
      try {
        deps.metrics.mcpServerOperationDuration.record((performance.now() - started) / 1000, {
          'mcp.method.name': method,
          ...(target.tool === undefined ? {} : { 'gen_ai.tool.name': target.tool }),
          ...(errorType === undefined ? {} : { 'error.type': errorType }),
        });
      } catch (error) {
        deps.logger.warn('metric could not be recorded', { error: String(error) });
      }
      span.end();
    }
  };
};

const isRequestLike = (method: string): boolean => !method.startsWith('notifications/');

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

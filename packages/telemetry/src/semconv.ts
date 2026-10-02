/**
 * MCP semantic-convention helpers (15.2): span names and attribute maps as pure functions.
 */

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** Attribute keys on MCP spans (15.2). */
export const ATTR = {
  mcpMethodName: 'mcp.method.name',
  mcpProtocolVersion: 'mcp.protocol.version',
  mcpSessionId: 'mcp.session.id',
  jsonrpcRequestId: 'jsonrpc.request.id',
  genAiOperationName: 'gen_ai.operation.name',
  genAiToolName: 'gen_ai.tool.name',
  genAiPromptName: 'gen_ai.prompt.name',
  genAiToolCallArguments: 'gen_ai.tool.call.arguments',
  genAiToolCallResult: 'gen_ai.tool.call.result',
  mcpResourceUri: 'mcp.resource.uri',
  errorType: 'error.type',
  rpcResponseStatusCode: 'rpc.response.status_code',
  networkTransport: 'network.transport',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  clientAddress: 'client.address',
  principalId: 'bastion.principal.id',
  principalType: 'bastion.principal.type',
  clientId: 'bastion.client.id',
  clientName: 'bastion.client.name',
  endpointId: 'bastion.endpoint.id',
  installationId: 'bastion.installation.id',
  installationSlug: 'bastion.installation.slug',
  catalogEntry: 'bastion.catalog.entry',
  catalogVersion: 'bastion.catalog.version',
  instanceId: 'bastion.instance.id',
  sandboxDriver: 'bastion.sandbox.driver',
  coldStart: 'bastion.cold_start',
  eraDownstream: 'bastion.era.downstream',
  eraUpstream: 'bastion.era.upstream',
  policyDecision: 'bastion.policy.decision',
  guardAction: 'bastion.guard.action',
} as const;

/** `gen_ai.operation.name` value for tool calls. */
export const GEN_AI_OPERATION_EXECUTE_TOOL = 'execute_tool';

/** Span names of the fixed Bastion spans (15.2). */
export const SPAN_NAMES = {
  authn: 'bastion.authn',
  policy: 'bastion.policy',
  limits: 'bastion.limits',
  instanceAcquire: 'bastion.instance.acquire',
  oauthRefresh: 'bastion.oauth.refresh',
  guard: (type: string): string => `bastion.guard ${type}`,
  forward: (method: string): string => `bastion.forward ${method}`,
  egressConnect: (host: string): string => `egress CONNECT ${host}`,
} as const;

/** Events recorded on `bastion.instance.acquire` (15.2). */
export const INSTANCE_ACQUIRE_EVENTS = [
  'claimed',
  'bound',
  'installed',
  'spawned',
  'connected',
] as const;

export interface McpTarget {
  toolName?: string | undefined;
  promptName?: string | undefined;
  resourceUri?: string | undefined;
}

/** The span-name target for a method: tool name, prompt name or resource URI. */
export const mcpTarget = (method: string, target: McpTarget): string | undefined => {
  if (method === 'tools/call') return target.toolName;
  if (method === 'prompts/get') return target.promptName;
  if (method.startsWith('resources/')) return target.resourceUri;
  return undefined;
};

/** `{mcp.method.name} {target}`, for example `tools/call github__create_issue`. */
export const mcpSpanName = (method: string, target?: string): string =>
  target === undefined || target === '' ? method : `${method} ${target}`;

export interface McpSpanInput extends McpTarget {
  method: string;
  protocolVersion?: string | undefined;
  /** Legacy sessions only. */
  sessionId?: string | undefined;
  requestId?: string | number | undefined;
  errorType?: string | undefined;
  /** JSON-RPC error code of the response, when it was an error. */
  rpcStatusCode?: number | undefined;
  networkTransport?: string | undefined;
  serverAddress?: string | undefined;
  serverPort?: number | undefined;
  clientAddress?: string | undefined;
  principalId?: string | undefined;
  principalType?: string | undefined;
  clientId?: string | undefined;
  clientName?: string | undefined;
  endpointId?: string | undefined;
  installationId?: string | undefined;
  installationSlug?: string | undefined;
  catalogEntry?: string | undefined;
  catalogVersion?: string | undefined;
  instanceId?: string | undefined;
  sandboxDriver?: string | undefined;
  coldStart?: boolean | undefined;
  eraDownstream?: string | undefined;
  eraUpstream?: string | undefined;
  policyDecision?: string | undefined;
  guardAction?: string | undefined;
  /** Tool-call arguments and result; recorded only when `captureContent` is true (15.2). */
  toolArguments?: unknown;
  toolResult?: unknown;
  captureContent?: boolean | undefined;
}

const put = (out: SpanAttributes, key: string, value: SpanAttributeValue | undefined): void => {
  if (value !== undefined) out[key] = value;
};

const toJson = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const buildAttributes = (input: McpSpanInput): SpanAttributes => {
  const out: SpanAttributes = {};
  put(out, ATTR.mcpMethodName, input.method);
  put(out, ATTR.mcpProtocolVersion, input.protocolVersion);
  put(out, ATTR.mcpSessionId, input.sessionId);
  put(
    out,
    ATTR.jsonrpcRequestId,
    input.requestId === undefined ? undefined : String(input.requestId),
  );
  if (input.method === 'tools/call') {
    out[ATTR.genAiOperationName] = GEN_AI_OPERATION_EXECUTE_TOOL;
    put(out, ATTR.genAiToolName, input.toolName);
  }
  if (input.method === 'prompts/get') put(out, ATTR.genAiPromptName, input.promptName);
  if (input.method.startsWith('resources/')) put(out, ATTR.mcpResourceUri, input.resourceUri);
  put(out, ATTR.errorType, input.errorType);
  put(
    out,
    ATTR.rpcResponseStatusCode,
    input.rpcStatusCode === undefined ? undefined : String(input.rpcStatusCode),
  );
  put(out, ATTR.networkTransport, input.networkTransport);
  put(out, ATTR.serverAddress, input.serverAddress);
  put(out, ATTR.serverPort, input.serverPort);
  put(out, ATTR.clientAddress, input.clientAddress);
  put(out, ATTR.principalId, input.principalId);
  put(out, ATTR.principalType, input.principalType);
  put(out, ATTR.clientId, input.clientId);
  put(out, ATTR.clientName, input.clientName);
  put(out, ATTR.endpointId, input.endpointId);
  put(out, ATTR.installationId, input.installationId);
  put(out, ATTR.installationSlug, input.installationSlug);
  put(out, ATTR.catalogEntry, input.catalogEntry);
  put(out, ATTR.catalogVersion, input.catalogVersion);
  put(out, ATTR.instanceId, input.instanceId);
  put(out, ATTR.sandboxDriver, input.sandboxDriver);
  put(out, ATTR.coldStart, input.coldStart);
  put(out, ATTR.eraDownstream, input.eraDownstream);
  put(out, ATTR.eraUpstream, input.eraUpstream);
  put(out, ATTR.policyDecision, input.policyDecision);
  put(out, ATTR.guardAction, input.guardAction);
  if (input.captureContent === true && input.method === 'tools/call') {
    put(out, ATTR.genAiToolCallArguments, toJson(input.toolArguments));
    put(out, ATTR.genAiToolCallResult, toJson(input.toolResult));
  }
  return out;
};

export interface McpSpanDescriptor {
  name: string;
  attributes: SpanAttributes;
}

/** SERVER span for a downstream MCP request (15.2). Never sets `server.*`; the client address is the peer. */
export const downstreamMcpSpan = (input: McpSpanInput): McpSpanDescriptor => {
  const { serverAddress: _a, serverPort: _p, ...rest } = input;
  return {
    name: mcpSpanName(input.method, mcpTarget(input.method, input)),
    attributes: buildAttributes(rest),
  };
};

/** CLIENT span for an upstream MCP request (15.2). Never sets `client.address`. */
export const upstreamMcpSpan = (input: McpSpanInput): McpSpanDescriptor => {
  const { clientAddress: _c, ...rest } = input;
  return {
    name: mcpSpanName(input.method, mcpTarget(input.method, input)),
    attributes: buildAttributes(rest),
  };
};

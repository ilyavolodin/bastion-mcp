import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it } from 'vitest';
import {
  ATTR,
  downstreamMcpSpan,
  extractTraceContext,
  INSTANCE_ACQUIRE_EVENTS,
  injectTraceContext,
  mcpSpanName,
  mcpTarget,
  SPAN_NAMES,
  selectTraceCarrier,
  upstreamMcpSpan,
} from '../src';

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TP_HDR = '00-11111111111111111111111111111111-2222222222222222-01';

describe('15.2 span names', () => {
  it('15.2 names MCP spans `{mcp.method.name} {target}`', () => {
    expect(mcpSpanName('tools/call', 'github__create_issue')).toBe(
      'tools/call github__create_issue',
    );
    expect(mcpSpanName('tools/list')).toBe('tools/list');
    expect(mcpSpanName('tools/list', '')).toBe('tools/list');
  });

  it('15.2 picks the target by method', () => {
    const t = { toolName: 'tool', promptName: 'prompt', resourceUri: 'file:///x' };
    expect(mcpTarget('tools/call', t)).toBe('tool');
    expect(mcpTarget('prompts/get', t)).toBe('prompt');
    expect(mcpTarget('resources/read', t)).toBe('file:///x');
    expect(mcpTarget('ping', t)).toBeUndefined();
  });

  it('15.2 names the fixed Bastion spans', () => {
    expect(SPAN_NAMES.authn).toBe('bastion.authn');
    expect(SPAN_NAMES.policy).toBe('bastion.policy');
    expect(SPAN_NAMES.limits).toBe('bastion.limits');
    expect(SPAN_NAMES.guard('prompt-injection')).toBe('bastion.guard prompt-injection');
    expect(SPAN_NAMES.instanceAcquire).toBe('bastion.instance.acquire');
    expect(SPAN_NAMES.forward('tools/call')).toBe('bastion.forward tools/call');
    expect(SPAN_NAMES.egressConnect('api.github.com')).toBe('egress CONNECT api.github.com');
    expect(SPAN_NAMES.oauthRefresh).toBe('bastion.oauth.refresh');
    expect(INSTANCE_ACQUIRE_EVENTS).toEqual([
      'claimed',
      'bound',
      'installed',
      'spawned',
      'connected',
    ]);
  });
});

describe('15.2 attributes', () => {
  const full = {
    method: 'tools/call',
    toolName: 'github__create_issue',
    protocolVersion: '2025-06-18',
    sessionId: 'sess-1',
    requestId: 42,
    errorType: 'tool_error',
    rpcStatusCode: -32013,
    networkTransport: 'tcp',
    serverAddress: 'mcp.example.com',
    serverPort: 443,
    clientAddress: '10.1.2.3',
    principalId: 'p',
    principalType: 'user',
    clientId: 'c',
    clientName: 'Claude',
    endpointId: 'e',
    installationId: 'i',
    installationSlug: 'gh',
    catalogEntry: 'github',
    catalogVersion: '1.0.0',
    instanceId: 'inst',
    sandboxDriver: 'bubblewrap',
    coldStart: true,
    eraDownstream: 'legacy',
    eraUpstream: 'modern',
    policyDecision: 'permit',
    guardAction: 'allow',
  } as const;

  it('15.2 emits the exact downstream attribute names for a tool call', () => {
    const { name, attributes } = downstreamMcpSpan(full);
    expect(name).toBe('tools/call github__create_issue');
    expect(attributes).toEqual({
      'mcp.method.name': 'tools/call',
      'mcp.protocol.version': '2025-06-18',
      'mcp.session.id': 'sess-1',
      'jsonrpc.request.id': '42',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'github__create_issue',
      'error.type': 'tool_error',
      'rpc.response.status_code': '-32013',
      'network.transport': 'tcp',
      'client.address': '10.1.2.3',
      'bastion.principal.id': 'p',
      'bastion.principal.type': 'user',
      'bastion.client.id': 'c',
      'bastion.client.name': 'Claude',
      'bastion.endpoint.id': 'e',
      'bastion.installation.id': 'i',
      'bastion.installation.slug': 'gh',
      'bastion.catalog.entry': 'github',
      'bastion.catalog.version': '1.0.0',
      'bastion.instance.id': 'inst',
      'bastion.sandbox.driver': 'bubblewrap',
      'bastion.cold_start': true,
      'bastion.era.downstream': 'legacy',
      'bastion.era.upstream': 'modern',
      'bastion.policy.decision': 'permit',
      'bastion.guard.action': 'allow',
    });
  });

  it('15.2 upstream spans carry server.* and never client.address', () => {
    const { attributes } = upstreamMcpSpan(full);
    expect(attributes['server.address']).toBe('mcp.example.com');
    expect(attributes['server.port']).toBe(443);
    expect(attributes).not.toHaveProperty('client.address');
    expect(downstreamMcpSpan(full).attributes).not.toHaveProperty('server.address');
  });

  it('15.2 sets gen_ai.prompt.name for prompts and mcp.resource.uri for resources only', () => {
    const p = downstreamMcpSpan({
      method: 'prompts/get',
      promptName: 'review',
      toolName: 'ignored',
    });
    expect(p.name).toBe('prompts/get review');
    expect(p.attributes).toMatchObject({ 'gen_ai.prompt.name': 'review' });
    expect(p.attributes).not.toHaveProperty('gen_ai.operation.name');
    expect(p.attributes).not.toHaveProperty('gen_ai.tool.name');
    const r = upstreamMcpSpan({ method: 'resources/read', resourceUri: 'file:///a' });
    expect(r.name).toBe('resources/read file:///a');
    expect(r.attributes['mcp.resource.uri']).toBe('file:///a');
    const l = downstreamMcpSpan({ method: 'tools/list' });
    expect(l.attributes).toEqual({ 'mcp.method.name': 'tools/list' });
  });

  it('15.2 records tool arguments and result only when captureContent is true', () => {
    const args = { q: 'secret-ish' };
    const off = downstreamMcpSpan({
      method: 'tools/call',
      toolName: 't',
      toolArguments: args,
      toolResult: 'r',
    });
    expect(off.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(off.attributes).not.toHaveProperty('gen_ai.tool.call.result');
    const explicitOff = downstreamMcpSpan({
      method: 'tools/call',
      toolArguments: args,
      captureContent: false,
    });
    expect(explicitOff.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
    const on = downstreamMcpSpan({
      method: 'tools/call',
      toolName: 't',
      toolArguments: args,
      toolResult: { content: [] },
      captureContent: true,
    });
    expect(on.attributes['gen_ai.tool.call.arguments']).toBe('{"q":"secret-ish"}');
    expect(on.attributes['gen_ai.tool.call.result']).toBe('{"content":[]}');
    const str = downstreamMcpSpan({
      method: 'tools/call',
      toolResult: 'plain',
      captureContent: true,
    });
    expect(str.attributes['gen_ai.tool.call.result']).toBe('plain');
    const circ: Record<string, unknown> = {};
    circ.c = circ;
    const bad = downstreamMcpSpan({
      method: 'tools/call',
      toolArguments: circ,
      captureContent: true,
    });
    expect(bad.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(ATTR.genAiToolCallArguments).toBe('gen_ai.tool.call.arguments');
  });
});

describe('15.2 trace context', () => {
  it('15.2 takes the parent from params._meta.traceparent when present', () => {
    const ctx = extractTraceContext(
      { traceparent: TP, tracestate: 'a=b' },
      { traceparent: TP_HDR },
    );
    const sc = trace.getSpanContext(ctx);
    expect(sc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(sc?.spanId).toBe('b7ad6b7169203331');
    expect(sc?.traceState?.get('a')).toBe('b');
  });

  it('15.2 falls back to the HTTP traceparent header', () => {
    const sc = trace.getSpanContext(extractTraceContext({}, { traceparent: TP_HDR }));
    expect(sc?.traceId).toBe('11111111111111111111111111111111');
    expect(
      trace.getSpanContext(extractTraceContext(undefined, { Traceparent: TP_HDR.toUpperCase() })),
    ).toBeUndefined();
    const upper = trace.getSpanContext(extractTraceContext(undefined, { TRACEPARENT: TP_HDR }));
    expect(upper?.traceId).toBe('11111111111111111111111111111111');
  });

  it('15.2 returns the base context when neither carrier has a traceparent', () => {
    expect(extractTraceContext(undefined, undefined)).toBe(ROOT_CONTEXT);
    expect(extractTraceContext({ traceparent: 5 }, { traceparent: [] })).toBe(ROOT_CONTEXT);
  });

  it('15.2 reads baggage and array-valued headers', () => {
    expect(selectTraceCarrier({}, { baggage: ['a=1', 'b=2'], traceparent: [TP_HDR] })).toEqual({
      baggage: 'a=1,b=2',
      traceparent: TP_HDR,
    });
    expect(selectTraceCarrier({ traceparent: TP, baggage: 'k=v' }, {})).toEqual({
      traceparent: TP,
      baggage: 'k=v',
    });
  });

  it('6.4 injects the context into both _meta and headers', () => {
    const cm = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(cm);
    try {
      const parent = extractTraceContext({ traceparent: TP, tracestate: 'a=b' }, undefined);
      const meta: Record<string, unknown> = { keep: 1 };
      const headers: Record<string, string> = {};
      injectTraceContext(meta, headers, parent);
      expect(meta.traceparent).toBe(TP);
      expect(headers.traceparent).toBe(TP);
      expect(meta.tracestate).toBe('a=b');
      expect(headers.tracestate).toBe('a=b');
      expect(meta.keep).toBe(1);

      const m2: Record<string, unknown> = {};
      const h2: Record<string, string> = {};
      context.with(parent, () => injectTraceContext(m2, h2));
      expect(m2.traceparent).toBe(TP);
      const m3: Record<string, unknown> = {};
      injectTraceContext(m3, {}, ROOT_CONTEXT);
      expect(m3).toEqual({});
    } finally {
      context.disable();
    }
  });
});

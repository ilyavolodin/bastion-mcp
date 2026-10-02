/** 15.2 spans and 15.3 metrics of the operation layer, recorded with in-memory exporters. */
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import { context, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEndpoint, installation, items, opContext } from './helpers/fixtures';
import { makeOps } from './helpers/ops';

type Recorded = { name: string; value: number; attrs: Record<string, unknown> | undefined };

const recorder = () => {
  const records: Recorded[] = [];
  const instrument = (name: string) => ({
    add: (value: number, attrs?: Record<string, unknown>) =>
      void records.push({ name, value, attrs }),
    record: (value: number, attrs?: Record<string, unknown>) =>
      void records.push({ name, value, attrs }),
  });
  const metrics = {
    mcpServerOperationDuration: instrument('mcp.server.operation.duration'),
    calls: instrument('bastion.calls'),
    limitsRejections: instrument('bastion.limits.rejections'),
  } as unknown as BastionMetrics;
  return { records, metrics };
};

describe('15.2 15.3 observability of operations', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const manager = new AsyncLocalStorageContextManager().enable();

  beforeAll(() => {
    context.setGlobalContextManager(manager);
  });
  afterAll(async () => {
    await provider.shutdown();
    manager.disable();
  });

  const setup = async (options: Parameters<typeof makeOps>[0] = {}) => {
    exporter.reset();
    const inst = installation('github', { catalogSlug: 'github' });
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const { records, metrics } = recorder();
    const ops = makeOps({ ...options, tracer: provider.getTracer('test'), metrics });
    return { ops, resolved, records, inst };
  };

  it('15.2 tools/call is a SERVER span named like the target with the MCP and Bastion attributes', async () => {
    const { ops, resolved, inst } = await setup();
    await ops.run(
      'tools/call',
      { name: 'github__echo', arguments: { text: 'x' } },
      opContext(resolved, {
        clientInfo: { name: 'claude', version: '1' },
        requestId: 7,
        sessionId: 's-1',
        era: 'legacy',
        protocolVersion: '2025-06-18',
      }),
    );
    const server = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
    expect(server?.name).toBe('tools/call github__echo');
    expect(server?.attributes).toMatchObject({
      'mcp.method.name': 'tools/call',
      'mcp.protocol.version': '2025-06-18',
      'mcp.session.id': 's-1',
      'jsonrpc.request.id': '7',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'github__echo',
      'bastion.principal.type': 'user',
      'bastion.client.name': 'claude',
      'bastion.era.downstream': 'legacy',
      'bastion.installation.id': inst.id,
      'bastion.installation.slug': 'github',
      'bastion.catalog.entry': 'github',
      'bastion.policy.decision': 'allow',
      'bastion.call.outcome': 'ok',
      'client.address': '127.0.0.1',
    });
    // The span continues the trace of the request.
    expect(server?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('15.2 policy, limits and each guard get INTERNAL child spans of the request span', async () => {
    const { ops, resolved } = await setup({
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g1',
              type: 'regex',
              config: { rules: [{ id: 'r', pattern: 'zzz', action: 'warn' }] },
            },
          ],
        },
      },
    });
    await ops.run('tools/call', { name: 'github__echo', arguments: {} }, opContext(resolved));
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'bastion.policy',
        'bastion.limits',
        'bastion.guard regex',
        'tools/call github__echo',
      ]),
    );
    const policy = spans.find((s) => s.name === 'bastion.policy');
    expect(policy?.kind).toBe(SpanKind.INTERNAL);
    expect(policy?.parentSpanContext?.spanId).toBe(
      spans.find((s) => s.kind === SpanKind.SERVER)?.spanContext().spanId,
    );
  });

  it('15.2 a failing operation ends its span with an error status and the error.type attribute', async () => {
    const { ops, resolved } = await setup();
    await ops
      .run('tools/call', { name: 'github__nope' }, opContext(resolved))
      .catch(() => undefined);
    const span = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['error.type']).toBe('INVALID_PARAMS');
    expect(span?.attributes['rpc.response.status_code']).toBe('-32602');
  });

  it('15.2 tool arguments and results are recorded only when content capture is on', async () => {
    const off = await setup();
    await off.ops.run(
      'tools/call',
      { name: 'github__echo', arguments: { text: 'secret' } },
      opContext(off.resolved),
    );
    expect(JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      'secret',
    );
    const on = await setup({ settings: { captureContent: true } });
    on.ops.upstream.script = () => ({
      kind: 'complete',
      result: { content: [{ type: 'text', text: 'the-result' }] },
    });
    await on.ops.run(
      'tools/call',
      { name: 'github__echo', arguments: { text: 'visible' } },
      opContext(on.resolved),
    );
    const server = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
    expect(String(server?.attributes['gen_ai.tool.call.arguments'])).toContain('visible');
    expect(String(server?.attributes['gen_ai.tool.call.result'])).toContain('the-result');
  });

  it('15.3 records mcp.server.operation.duration with method and tool, bastion.calls with the outcome, and never a user id', async () => {
    const { ops, resolved, records } = await setup();
    await ops.run('tools/call', { name: 'github__echo', arguments: {} }, opContext(resolved));
    await ops.run('tools/list', {}, opContext(resolved));
    const duration = records.filter((r) => r.name === 'mcp.server.operation.duration');
    expect(duration.map((d) => d.attrs?.['mcp.method.name'])).toEqual(['tools/call', 'tools/list']);
    expect(duration[0]?.attrs?.['gen_ai.tool.name']).toBe('github__echo');
    expect(duration[0]?.value).toBeGreaterThan(0);
    const calls = records.filter((r) => r.name === 'bastion.calls');
    expect(calls).toEqual([
      {
        name: 'bastion.calls',
        value: 1,
        attrs: { 'bastion.catalog.entry': 'github', outcome: 'ok' },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(opContext(resolved).principal.id);
  });

  it('15.3 failures carry error.type on the duration histogram and limit rejections are counted by rule and kind', async () => {
    const { ops, resolved, records } = await setup({
      rules: [
        {
          id: 'rl',
          name: 'rl-name',
          subject: 'user',
          subjectMatch: 'each',
          scope: {},
          kind: 'rate',
          params: { points: 1, perSeconds: 60, burst: 0 },
          metric: 'calls',
          action: 'reject',
          enabled: true,
        },
      ],
    });
    await ops.run('tools/call', { name: 'github__echo', arguments: {} }, opContext(resolved));
    await ops.run('tools/call', { name: 'github__echo', arguments: {} }, opContext(resolved));
    await ops
      .run('tools/call', { name: 'github__nope', arguments: {} }, opContext(resolved))
      .catch(() => undefined);
    expect(
      records.some(
        (r) =>
          r.name === 'bastion.limits.rejections' &&
          r.attrs?.rule === 'rl-name' &&
          r.attrs?.kind === 'rate',
      ),
    ).toBe(true);
    expect(
      records.some(
        (r) =>
          r.name === 'mcp.server.operation.duration' &&
          r.attrs?.['error.type'] === 'INVALID_PARAMS',
      ),
    ).toBe(true);
    expect(records.filter((r) => r.name === 'bastion.calls').map((r) => r.attrs?.outcome)).toEqual([
      'ok',
      'rate_limited',
    ]);
  });

  it('15.2 the upstream request carries the traceparent of the downstream span', async () => {
    const { ops, resolved } = await setup();
    await ops.run('tools/call', { name: 'github__echo', arguments: {} }, opContext(resolved));
    const server = exporter.getFinishedSpans().find((s) => s.kind === SpanKind.SERVER);
    const sent = ops.upstream.calls[0]?.ctx.trace.traceparent ?? '';
    expect(sent).toContain(server?.spanContext().traceId ?? 'x');
    expect(trace.getSpanContext(context.active())).toBeUndefined();
  });
});

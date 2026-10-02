import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EraCache } from '../src/connectors/era-cache';
import type { OpOptions, UpstreamSession } from '../src/connectors/types';
import type { InstanceManager } from '../src/instances/manager';
import { LeaseManager } from '../src/ownership/lease';
import { WorkerRegistry } from '../src/ownership/registry';
import { InternalRpcClient } from '../src/rpc/client';
import { createInternalRpcServer } from '../src/rpc/server';
import type { RemotePool } from '../src/service/pool';
import { UpstreamService } from '../src/service/service';
import type { JsonObject, SessionOutcome, WireContext } from '../src/types';
import { FakeRedis } from './helpers/fake-redis';
import { ctxOf, installationOf, remoteSpec } from './helpers/fixtures';
import { connectUrls, FakeCredentials, MemoryInstallations } from './helpers/memory-ports';
import { keyring } from './helpers/runtime';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  trace.disable();
  context.disable();
  await provider.shutdown();
});
beforeEach(() => exporter.reset());

const sessionFor = (
  script: (method: string, params: JsonObject, options: OpOptions) => SessionOutcome,
): UpstreamSession =>
  ({
    era: 'modern',
    protocolVersion: '2026-07-28',
    sessionId: undefined,
    serverCapabilities: {},
    serverInfo: undefined,
    instructions: undefined,
    closed: false,
    request: async (m: string, p: JsonObject, o: OpOptions) => script(m, p, o),
    onNotification: () => () => undefined,
    onClose: () => undefined,
    close: async () => undefined,
    hasContinuation: () => false,
  }) as unknown as UpstreamSession;

const serviceWith = (
  session: UpstreamSession,
  extras: Partial<ConstructorParameters<typeof UpstreamService>[0]> = {},
) => {
  const redis = new FakeRedis();
  const registry = new WorkerRegistry({
    redis,
    workerId: 'w1',
    address: 'x:1',
    role: 'worker',
    version: '1',
  });
  const installations = new MemoryInstallations();
  const inst = installations.add(
    installationOf(remoteSpec('https://a.example/mcp'), {
      installationId: 'inst-a',
      slug: 'github',
      catalogEntryName: 'github-entry',
    }),
  );
  const service = new UpstreamService({
    redis,
    registry,
    leases: new LeaseManager({ redis, registry }),
    instances: {} as InstanceManager,
    pool: {
      get: async () => ({ era: 'modern' as const, session }),
      closeAll: async () => undefined,
    } as unknown as RemotePool,
    eraCache: {} as EraCache,
    rpc: {} as InternalRpcClient,
    installations,
    credentials: new FakeCredentials(),
    connectUrls,
    stateKeyring: keyring,
    ...extras,
  });
  return { service, inst };
};

describe('15.2 traces of upstream calls', () => {
  it('15.2 an upstream MCP request is a CLIENT span named {method} {target} with the MCP attributes', async () => {
    const { service, inst } = serviceWith(sessionFor(() => ({ kind: 'complete', result: {} })));
    await service.execute({
      installationId: inst.installationId,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: {} },
      ctx: ctxOf(),
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'tools/call create_issue');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toMatchObject({
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'create_issue',
      'bastion.installation.id': 'inst-a',
      'bastion.installation.slug': 'github',
      'bastion.catalog.entry': 'github-entry',
      'bastion.era.upstream': 'modern',
      'bastion.era.downstream': 'modern',
    });
  });

  it('6.4 the upstream request carries the context of its CLIENT span in the trace carrier', async () => {
    const seen: string[] = [];
    const { service, inst } = serviceWith(
      sessionFor((_m, _p, options) => {
        seen.push(options.ctx.trace.traceparent ?? '');
        return { kind: 'complete', result: {} };
      }),
    );
    await service.execute({
      installationId: inst.installationId,
      method: 'tools/call',
      params: { name: 'x' },
      ctx: ctxOf(),
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'tools/call x');
    const sc = span?.spanContext();
    expect(seen[0]).toBe(`00-${sc?.traceId}-${sc?.spanId}-01`);
  });

  it('15.2 a failing upstream call marks the span as an error and still records the duration metric', async () => {
    const recorded: { value: number; attrs: Record<string, unknown> }[] = [];
    const metrics = {
      mcpClientOperationDuration: {
        record: (value: number, attrs?: object) =>
          void recorded.push({ value, attrs: { ...attrs } }),
      },
    };
    const { service, inst } = serviceWith(
      sessionFor(() => {
        throw new Error('boom');
      }),
      { metrics },
    );
    await expect(
      service.execute({
        installationId: inst.installationId,
        method: 'tools/call',
        params: { name: 'x' },
        ctx: ctxOf(),
      }),
    ).rejects.toBeDefined();
    const span = exporter.getFinishedSpans().find((s) => s.name === 'tools/call x');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attrs).toMatchObject({
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'x',
      'error.type': 'Error',
      'bastion.catalog.entry': 'github-entry',
    });
    expect(recorded[0]?.value).toBeGreaterThanOrEqual(0);
  });
});

describe('21.2 15.2 15.3 forwarding spans and metrics', () => {
  const wire: WireContext = {
    principal: { userId: 'u1' },
    installationId: 'inst-a',
    era: 'modern',
    clientCapabilities: {},
    trace: {},
  };

  it('15.2 bastion.forward {method} is a CLIENT span on the caller and a SERVER span on the owner, in one trace', async () => {
    const secret = 'k'.repeat(40);
    const server = createInternalRpcServer({
      secret,
      handlers: {
        op: async () => ({ kind: 'complete', result: {} }),
        resume: async () => ({ kind: 'complete', result: {} }),
        subscriptions: async () => undefined,
      },
    });
    const listener = await server.listen(0, '127.0.0.1');
    const counts: { outcome: string }[] = [];
    const client = new InternalRpcClient({
      secret,
      metrics: {
        forwardedRequests: {
          add: (_v: number, attrs?: { outcome: string }) =>
            void counts.push({ outcome: attrs?.outcome ?? '' }),
        },
      },
    });
    try {
      await tracer().startActiveSpan('downstream request', async (parent) => {
        await client.forwardOp(`127.0.0.1:${listener.port}`, 'inst-1', {
          method: 'tools/call',
          params: {},
          ctx: wire,
        });
        parent.end();
      });
      await new Promise((r) => setTimeout(r, 50));
      const spans = exporter.getFinishedSpans();
      const clientSpan = spans.find(
        (s) => s.name === 'bastion.forward tools/call' && s.kind === SpanKind.CLIENT,
      );
      const serverSpan = spans.find(
        (s) => s.name === 'bastion.forward tools/call' && s.kind === SpanKind.SERVER,
      );
      expect(clientSpan).toBeDefined();
      expect(serverSpan).toBeDefined();
      expect(serverSpan?.spanContext().traceId).toBe(clientSpan?.spanContext().traceId);
      expect(serverSpan?.parentSpanContext?.spanId).toBe(clientSpan?.spanContext().spanId);
      expect(counts).toEqual([{ outcome: 'ok' }]);
      // A connect failure is counted separately.
      await client
        .forwardOp('127.0.0.1:1', 'i', { method: 'tools/call', params: {}, ctx: wire })
        .catch(() => undefined);
      expect(counts.at(-1)).toEqual({ outcome: 'connect_failed' });
      // An owner-side error is an error outcome.
      const failing = createInternalRpcServer({
        secret,
        handlers: {
          op: async () => {
            throw new Error('x');
          },
          resume: async () => ({ kind: 'complete', result: {} }),
          subscriptions: async () => undefined,
        },
      });
      const l2 = await failing.listen(0, '127.0.0.1');
      await client
        .forwardOp(`127.0.0.1:${l2.port}`, 'i', { method: 'tools/call', params: {}, ctx: wire })
        .catch(() => undefined);
      await l2.close();
      expect(counts.at(-1)).toEqual({ outcome: 'error' });
    } finally {
      await client.close();
      await listener.close();
    }
  });
});

const tracer = () => trace.getTracer('test');

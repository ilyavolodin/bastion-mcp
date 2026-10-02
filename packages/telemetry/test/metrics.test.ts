import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import {
  assertNoUserIdAttributes,
  createMetrics,
  FORBIDDEN_METRIC_ATTRIBUTES,
  METRIC_DEFS,
  MetricCardinalityError,
} from '../src';

const setup = () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const m = createMetrics(provider.getMeter('bastion-test'));
  const collect = async () => {
    await reader.forceFlush();
    return exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics);
  };
  return { m, collect, provider };
};

describe('15.3 metrics registry', () => {
  it('15.3 registers every instrument with the exact name, type and unit', async () => {
    const { m, collect, provider } = setup();
    m.mcpServerOperationDuration.record(0.1, { 'mcp.method.name': 'tools/call' });
    m.mcpClientOperationDuration.record(0.1, {
      'mcp.method.name': 'tools/call',
      'bastion.catalog.entry': 'gh',
    });
    m.mcpServerSessionDuration.record(30);
    m.calls.add(1, { 'bastion.catalog.entry': 'gh', outcome: 'ok' });
    m.guardEvaluations.add(1, { guard: 'pii', phase: 'request', verdict: 'pass', action: 'allow' });
    m.guardDuration.record(0.01, { guard: 'pii' });
    m.limitsRejections.add(1, { rule: 'r', kind: 'rate' });
    m.sandboxStarts.add(1, { driver: 'bubblewrap', outcome: 'ok', warm: false });
    m.sandboxStartDuration.record(1.2, { driver: 'bubblewrap', phase: 'spawn' });
    m.sandboxesActive.record(3, { driver: 'bubblewrap', size: 'small' });
    m.instancesActive.record(2, { kind: 'sandbox' });
    m.streamsActive.record(1, { era: 'modern', type: 'listen' });
    m.forwardedRequests.add(1, { outcome: 'ok' });
    m.upstreamOauthRefreshes.add(1, { outcome: 'ok' });
    m.egressConnections.add(1, { decision: 'allow' });
    m.configCompileDuration.record(0.2);
    m.calllogDropped.add(5);
    m.pluginsFetches.add(1, { channel: 'git', marketplace: 'acme' });
    m.limitsDegraded.add(1);
    const out = await collect();
    const byName = new Map(out.map((x) => [x.descriptor.name, x]));
    const kind = (t: DataPointType) =>
      t === DataPointType.HISTOGRAM ? 'histogram' : t === DataPointType.GAUGE ? 'gauge' : 'counter';
    for (const def of Object.values(METRIC_DEFS)) {
      const metric = byName.get(def.name);
      expect(metric, def.name).toBeDefined();
      expect(metric?.descriptor.unit, def.name).toBe(def.unit);
      expect(kind(metric?.dataPointType ?? DataPointType.SUM), def.name).toBe(def.type);
    }
    expect(Object.keys(METRIC_DEFS)).toHaveLength(19);
    expect(byName.get('bastion.calllog.dropped')?.dataPoints[0]?.value).toBe(5);
    await provider.shutdown();
  });

  it('15.3 uses seconds for histograms named in the table', () => {
    for (const def of Object.values(METRIC_DEFS)) {
      if (def.type === 'histogram') expect(def.unit).toBe('s');
    }
    expect(METRIC_DEFS.mcpServerOperationDuration.name).toBe('mcp.server.operation.duration');
  });

  it('15.3 passes attributes through to the data point', async () => {
    const { m, collect, provider } = setup();
    m.calls.add(2, { 'bastion.catalog.entry': 'personal', outcome: 'ok' });
    const calls = (await collect()).find((x) => x.descriptor.name === 'bastion.calls');
    expect(calls?.dataPoints[0]?.attributes).toEqual({
      'bastion.catalog.entry': 'personal',
      outcome: 'ok',
    });
    await provider.shutdown();
  });

  it('15.3 never records user IDs as metric attributes (runtime guard)', () => {
    const { m } = setup();
    for (const key of FORBIDDEN_METRIC_ATTRIBUTES) {
      const attrs = { 'bastion.catalog.entry': 'x', outcome: 'ok', [key]: 'u-1' };
      expect(() => m.calls.add(1, attrs as never)).toThrow(MetricCardinalityError);
    }
    expect(() => m.guardDuration.record(1, { guard: 'g', userId: 'u' } as never)).toThrow(
      /forbidden/,
    );
    expect(() => assertNoUserIdAttributes(undefined)).not.toThrow();
    expect(() => assertNoUserIdAttributes({ fine: 1 })).not.toThrow();
  });

  it('15.3 rejects user IDs at the type level', () => {
    const { m } = setup();
    expect(() =>
      m.calls.add(1, {
        'bastion.catalog.entry': 'x',
        outcome: 'ok',
        // @ts-expect-error user IDs are not allowed as metric attributes
        userId: 'u',
      }),
    ).toThrow();
    expect(() =>
      m.forwardedRequests.add(1, {
        outcome: 'ok',
        // @ts-expect-error principal ids are not allowed either
        'bastion.principal.id': 'p',
      }),
    ).toThrow();
  });

  it('15.3 drops undefined attribute values instead of exporting them', async () => {
    const { m, collect, provider } = setup();
    m.mcpServerOperationDuration.record(1, { 'mcp.method.name': 'ping', 'error.type': undefined });
    const h = (await collect()).find((x) => x.descriptor.name === 'mcp.server.operation.duration');
    expect(h?.dataPoints[0]?.attributes).toEqual({ 'mcp.method.name': 'ping' });
    await provider.shutdown();
    expect(metrics).toBeDefined();
  });
});

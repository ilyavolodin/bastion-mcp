import { metrics, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapOtel,
  buildResourceAttributes,
  buildSampler,
  defaultInstrumentations,
  type OtelHandle,
  otelOptionsFromEnv,
  startOtelFromEnv,
} from '../src';

const base = {
  serviceName: 'bastion-worker',
  serviceVersion: '1.2.3',
  instanceId: 'worker-1',
  environment: 'test',
} as const;

let handle: OtelHandle | null = null;
afterEach(async () => {
  await handle?.shutdown();
  handle = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

const inMemory = () => {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logExporter = new InMemoryLogRecordExporter();
  return {
    spans,
    metricExporter,
    logExporter,
    options: {
      spanProcessors: [new SimpleSpanProcessor(spans)],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 3_600_000,
        }),
      ],
      logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
      instrumentations: [],
    },
  };
};

describe('15.1 bootstrapOtel', () => {
  it('15.1 attaches service.name, version, instance id and environment to every span', async () => {
    const mem = inMemory();
    handle = bootstrapOtel({ ...base, ...mem.options });
    trace.getTracer('t').startSpan('op').end();
    await vi.waitFor(() => expect(mem.spans.getFinishedSpans()).toHaveLength(1));
    const [span] = mem.spans.getFinishedSpans();
    expect(span?.resource.attributes).toMatchObject({
      'service.name': 'bastion-worker',
      'service.version': '1.2.3',
      'service.instance.id': 'worker-1',
      'deployment.environment.name': 'test',
    });
  });

  it('15.1 exports traces, metrics and logs through the configured pipelines', async () => {
    const mem = inMemory();
    handle = bootstrapOtel({ ...base, serviceName: 'bastion-ui', ...mem.options });
    trace.getTracer('t').startSpan('op').end();
    metrics.getMeter('m').createCounter('c').add(1);
    logs.getLogger('l').emit({ body: 'hello' });
    await vi.waitFor(() => expect(mem.spans.getFinishedSpans()).toHaveLength(1));
    await vi.waitFor(() => expect(mem.logExporter.getFinishedLogRecords()).toHaveLength(1));
    expect(mem.spans.getFinishedSpans()[0]?.resource.attributes['service.name']).toBe('bastion-ui');
    expect(mem.logExporter.getFinishedLogRecords()[0]?.body).toBe('hello');
    await handle.shutdown();
    expect(mem.metricExporter.getMetrics().length).toBeGreaterThan(0);
  });

  it('15.1 samples with parentbased_traceidratio at BASTION_TRACE_SAMPLE_RATIO', async () => {
    const mem = inMemory();
    handle = bootstrapOtel({ ...base, sampleRatio: 0, ...mem.options });
    const dropped = trace.getTracer('t').startSpan('dropped');
    expect(dropped.isRecording()).toBe(false);
    dropped.end();
    await handle.shutdown();
    expect(mem.spans.getFinishedSpans()).toHaveLength(0);
  });

  it('15.1 the sampler follows the parent decision and the ratio for roots', () => {
    const traceId = 'ffffffffffffffffffffffffffffffff';
    const decide = (s: ReturnType<typeof buildSampler>, parentSampled?: boolean) =>
      s.shouldSample(
        parentSampled === undefined
          ? ROOT_CONTEXT
          : trace.setSpanContext(ROOT_CONTEXT, {
              traceId,
              spanId: '1111111111111111',
              traceFlags: parentSampled ? 1 : 0,
              isRemote: true,
            }),
        traceId,
        'n',
        0,
        {},
        [],
      ).decision;
    expect(decide(buildSampler())).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(buildSampler(0))).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(buildSampler(0), true)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(buildSampler(1), false)).toBe(SamplingDecision.NOT_RECORD);
    expect(buildSampler(0.5).toString()).toContain('ParentBased');
  });

  it('15.1 builds the resource attribute map', () => {
    expect(buildResourceAttributes(base)).toEqual({
      'service.name': 'bastion-worker',
      'service.version': '1.2.3',
      'service.instance.id': 'worker-1',
      'deployment.environment.name': 'test',
    });
  });

  it('15.1 instruments http, undici, fastify, pg, ioredis and pino', () => {
    const names = defaultInstrumentations().map((i) => i.instrumentationName);
    expect(names).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-undici',
      '@opentelemetry/instrumentation-fastify',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-ioredis',
      '@opentelemetry/instrumentation-pino',
    ]);
  });

  it('15.1 shuts down cleanly and repeatedly', async () => {
    const mem = inMemory();
    const h = bootstrapOtel({ ...base, ...mem.options });
    await h.shutdown();
    await h.shutdown();
    trace.disable();
    metrics.disable();
    logs.disable();
  });

  it('15.1 starts a Prometheus scrape endpoint only when a port is set', async () => {
    const mem = inMemory();
    handle = bootstrapOtel({ ...base, prometheusPort: 39464, ...mem.options });
    metrics.getMeter('m').createCounter('prom_test').add(1);
    const res = await fetch('http://127.0.0.1:39464/metrics', {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('prom_test');
  });

  it('15.1 builds default OTLP exporters when none are injected', async () => {
    handle = bootstrapOtel({ ...base, instrumentations: [] });
    expect(handle.sampler).toBeDefined();
  });
});

describe('15.1 startOtelFromEnv', () => {
  it('19.1 reads role, sample ratio, Prometheus port and worker id from the environment', () => {
    expect(
      otelOptionsFromEnv(
        {
          BASTION_ROLE: 'ui',
          BASTION_TRACE_SAMPLE_RATIO: '0.25',
          BASTION_PROMETHEUS_PORT: '9464',
          BASTION_WORKER_ID: 'w-9',
          BASTION_VERSION: '2.0.0',
          BASTION_ENVIRONMENT: 'staging',
        },
        'fallback',
      ),
    ).toEqual({
      serviceName: 'bastion-ui',
      serviceVersion: '2.0.0',
      instanceId: 'w-9',
      environment: 'staging',
      sampleRatio: 0.25,
      prometheusPort: 9464,
    });
  });

  it('19.1 defaults to a worker with full sampling and no Prometheus endpoint', () => {
    expect(otelOptionsFromEnv({ BASTION_PROMETHEUS_PORT: '' }, 'host-1')).toEqual({
      serviceName: 'bastion-worker',
      serviceVersion: '0.0.0',
      instanceId: 'host-1',
      environment: 'production',
      sampleRatio: 1,
      prometheusPort: undefined,
    });
  });

  it('19.1 rejects an invalid sample ratio and honours OTEL_SDK_DISABLED', () => {
    expect(() => otelOptionsFromEnv({ BASTION_TRACE_SAMPLE_RATIO: '2' }, 'x')).toThrow();
    expect(otelOptionsFromEnv({ OTEL_SDK_DISABLED: 'true' }, 'x')).toBeNull();
    expect(startOtelFromEnv({ OTEL_SDK_DISABLED: '1' })).toBeNull();
  });

  it('15.1 starts from the environment', async () => {
    const h = startOtelFromEnv({ OTEL_SDK_DISABLED: 'false', BASTION_TRACE_SAMPLE_RATIO: '0' });
    expect(h).not.toBeNull();
    await h?.shutdown();
    trace.disable();
    metrics.disable();
    logs.disable();
  });
});

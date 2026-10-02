/**
 * OpenTelemetry bootstrap (15.1). `bootstrapOtel` builds and starts `@opentelemetry/sdk-node`; the
 * `otel-register.ts` entry calls `startOtelFromEnv` so it can be loaded first with `node --import`.
 */

import { hostname } from 'node:os';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { type IMetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type Sampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

export type OtelSignal = 'traces' | 'metrics' | 'logs';

export type BastionServiceName = 'bastion-worker' | 'bastion-ui';

export interface OtelOptions {
  serviceName: BastionServiceName;
  serviceVersion: string;
  /** Worker ID, reported as `service.instance.id`. */
  instanceId: string;
  environment: string;
  /** `BASTION_TRACE_SAMPLE_RATIO`, default 1. */
  sampleRatio?: number | undefined;
  /** `BASTION_PROMETHEUS_PORT`; the scrape endpoint is off when unset. */
  prometheusPort?: number | undefined;
  /**
   * Overrides for tests and embedders. When given, they replace the OTLP http/protobuf defaults
   * (which are configured by the standard `OTEL_EXPORTER_OTLP_*` variables).
   */
  spanProcessors?: SpanProcessor[] | undefined;
  metricReaders?: IMetricReader[] | undefined;
  logRecordProcessors?: LogRecordProcessor[] | undefined;
  /** Signals whose exporter is `none` (`OTEL_<SIGNAL>_EXPORTER=none`): nothing is exported for them. */
  disabledSignals?: OtelSignal[] | undefined;
  /** Replaces the default instrumentation set (http, undici, fastify, pg, ioredis, pino). */
  instrumentations?: Instrumentation[] | undefined;
}

export interface OtelHandle {
  sampler: Sampler;
  /** Flushes and stops every provider; safe to call more than once. */
  shutdown(): Promise<void>;
}

/** `parentbased_traceidratio` with the configured ratio (15.1). */
export const buildSampler = (ratio = 1): Sampler =>
  new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });

export const buildResourceAttributes = (
  options: Pick<OtelOptions, 'serviceName' | 'serviceVersion' | 'instanceId' | 'environment'>,
): Record<string, string> => ({
  'service.name': options.serviceName,
  'service.version': options.serviceVersion,
  'service.instance.id': options.instanceId,
  'deployment.environment.name': options.environment,
});

/** The default instrumentation set (15.1). pino log sending is off: Bastion's logger has its own bridge. */
export const defaultInstrumentations = (): Instrumentation[] => [
  new HttpInstrumentation(),
  new UndiciInstrumentation(),
  new FastifyInstrumentation(),
  new PgInstrumentation(),
  new IORedisInstrumentation(),
  new PinoInstrumentation({ disableLogSending: true }),
];

export const bootstrapOtel = (options: OtelOptions): OtelHandle => {
  const sampler = buildSampler(options.sampleRatio);
  const off = new Set(options.disabledSignals ?? []);
  const metricReaders: IMetricReader[] = off.has('metrics')
    ? []
    : [
        ...(options.metricReaders ?? [
          new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
        ]),
      ];
  if (options.prometheusPort !== undefined) {
    metricReaders.push(new PrometheusExporter({ port: options.prometheusPort }));
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes(buildResourceAttributes(options)),
    sampler,
    spanProcessors: off.has('traces')
      ? []
      : (options.spanProcessors ?? [new BatchSpanProcessor(new OTLPTraceExporter())]),
    metricReaders,
    logRecordProcessors: off.has('logs')
      ? []
      : (options.logRecordProcessors ?? [
          new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
        ]),
    instrumentations: options.instrumentations ?? defaultInstrumentations(),
  });
  sdk.start();
  let stopped: Promise<void> | undefined;
  return {
    sampler,
    shutdown: () => {
      stopped ??= sdk.shutdown();
      return stopped;
    },
  };
};

const boolish = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** The subset of the environment (19.1) the bootstrap needs, parsed without the full `loadConfig`. */
const envSchema = z.object({
  BASTION_ROLE: z.enum(['worker', 'ui', 'all']).default('all'),
  BASTION_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
  BASTION_PROMETHEUS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  BASTION_WORKER_ID: z.string().min(1).optional(),
  BASTION_VERSION: z.string().min(1).default(pkg.version),
  BASTION_ENVIRONMENT: z.string().min(1).default('production'),
  OTEL_SDK_DISABLED: boolish,
  OTEL_TRACES_EXPORTER: z.string().optional(),
  OTEL_METRICS_EXPORTER: z.string().optional(),
  OTEL_LOGS_EXPORTER: z.string().optional(),
});

export type OtelEnv = Record<string, string | undefined>;

/** Build options from the environment; `null` when `OTEL_SDK_DISABLED=true`. */
export const otelOptionsFromEnv = (
  env: OtelEnv,
  fallbackInstanceId: string,
): OtelOptions | null => {
  const e = envSchema.parse({
    ...env,
    BASTION_PROMETHEUS_PORT: env.BASTION_PROMETHEUS_PORT || undefined,
  });
  if (e.OTEL_SDK_DISABLED) return null;
  const isNone = (v: string | undefined): boolean =>
    v
      ?.split(',')
      .map((x) => x.trim().toLowerCase())
      .includes('none') === true;
  const disabledSignals: OtelSignal[] = [
    ...(isNone(e.OTEL_TRACES_EXPORTER) ? (['traces'] as const) : []),
    ...(isNone(e.OTEL_METRICS_EXPORTER) ? (['metrics'] as const) : []),
    ...(isNone(e.OTEL_LOGS_EXPORTER) ? (['logs'] as const) : []),
  ];
  return {
    serviceName: e.BASTION_ROLE === 'ui' ? 'bastion-ui' : 'bastion-worker',
    serviceVersion: e.BASTION_VERSION,
    instanceId: e.BASTION_WORKER_ID ?? fallbackInstanceId,
    environment: e.BASTION_ENVIRONMENT,
    sampleRatio: e.BASTION_TRACE_SAMPLE_RATIO,
    prometheusPort: e.BASTION_PROMETHEUS_PORT,
    ...(disabledSignals.length > 0 ? { disabledSignals } : {}),
  };
};

export const startOtelFromEnv = (
  env: OtelEnv = process.env,
  fallbackInstanceId = `${hostname()}-${process.pid}`,
): OtelHandle | null => {
  const options = otelOptionsFromEnv(env, fallbackInstanceId);
  return options === null ? null : bootstrapOtel(options);
};

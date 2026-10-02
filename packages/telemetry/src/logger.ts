/**
 * Logger (15.4): pino JSON to stdout with `trace_id` / `span_id` from the active span, redaction of
 * secrets, and an optional bridge that emits every record as an OTEL log record.
 */
import { trace } from '@opentelemetry/api';
import {
  type AnyValueMap,
  type Logger as OtelLogger,
  SeverityNumber,
} from '@opentelemetry/api-logs';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'accessToken',
  'refreshToken',
  '*.token',
  '*.secret',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerConfig {
  level: LogLevel;
  /** Defaults to stdout. */
  destination?: DestinationStream | undefined;
  /** Static fields on every record, e.g. `{ 'service.name': 'bastion-worker' }`. */
  base?: Record<string, unknown> | undefined;
  /** When set, every record is also emitted through this OTEL logger (the log bridge). */
  otelLogger?: OtelLogger | undefined;
}

/** `trace_id` / `span_id` of the active span; empty when none is recording. */
export const traceMixin = (): { trace_id?: string; span_id?: string } => {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx === undefined || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
};

const severityByLevel: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};
const severityTextByLevel: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A pino destination that forwards each JSON line to an OTEL logger. */
export const createOtelLogStream = (otelLogger: OtelLogger): DestinationStream => ({
  write(line: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      record = Object.fromEntries(Object.entries(parsed));
    } catch {
      return;
    }
    const level = typeof record.level === 'number' ? record.level : 30;
    const { level: _l, time, msg, ...rest } = record;
    const attributes: AnyValueMap = {};
    for (const [key, value] of Object.entries(rest)) {
      attributes[key] = isPrimitive(value) ? value : JSON.stringify(value);
    }
    otelLogger.emit({
      severityNumber: severityByLevel[level] ?? SeverityNumber.INFO,
      severityText: severityTextByLevel[level] ?? 'INFO',
      body: typeof msg === 'string' ? msg : '',
      attributes,
      ...(typeof time === 'number' ? { timestamp: time } : {}),
    });
  },
});

export const createLogger = (config: LoggerConfig): Logger => {
  const options: LoggerOptions = {
    level: config.level,
    mixin: traceMixin,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    ...(config.base === undefined ? {} : { base: config.base }),
  };
  const primary: DestinationStream = config.destination ?? pino.destination(1);
  if (config.otelLogger === undefined) return pino(options, primary);
  return pino(
    options,
    pino.multistream([
      { stream: primary, level: config.level === 'silent' ? 'fatal' : config.level },
      {
        stream: createOtelLogStream(config.otelLogger),
        level: config.level === 'silent' ? 'fatal' : config.level,
      },
    ]),
  );
};

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createOtelLogStream, REDACT_PATHS, traceMixin } from '../src';

const sink = () => {
  const lines: string[] = [];
  return { lines, stream: { write: (l: string) => void lines.push(l) } };
};

describe('15.4 logger', () => {
  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterEach(() => {
    context.disable();
  });

  it('15.4 writes JSON lines', () => {
    const { lines, stream } = sink();
    createLogger({ level: 'info', destination: stream }).info({ a: 1 }, 'hello');
    const rec = JSON.parse(lines[0] ?? '');
    expect(rec).toMatchObject({ a: 1, msg: 'hello', level: 30 });
    expect(rec).not.toHaveProperty('trace_id');
  });

  it('15.4 adds trace_id and span_id from the active span', () => {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    const { lines, stream } = sink();
    const log = createLogger({ level: 'info', destination: stream });
    const span = provider.getTracer('t').startSpan('op');
    context.with(trace.setSpan(context.active(), span), () => log.info('inside'));
    log.info('outside');
    const inside = JSON.parse(lines[0] ?? '');
    expect(inside.trace_id).toBe(span.spanContext().traceId);
    expect(inside.span_id).toBe(span.spanContext().spanId);
    expect(JSON.parse(lines[1] ?? '')).not.toHaveProperty('trace_id');
    expect(traceMixin()).toEqual({});
    span.end();
  });

  it('15.4 redacts authorization, cookie and token-like fields', () => {
    const { lines, stream } = sink();
    const log = createLogger({ level: 'info', destination: stream });
    log.info(
      {
        authorization: 'Bearer x',
        cookie: 'sid=1',
        a: {
          token: 't',
          secret: 's',
          password: 'p',
          accessToken: 'at',
          refreshToken: 'rt',
          safe: 'ok',
        },
      },
      'm',
    );
    const rec = JSON.parse(lines[0] ?? '');
    expect(rec.authorization).toBe('[REDACTED]');
    expect(rec.cookie).toBe('[REDACTED]');
    expect(rec.a).toEqual({
      token: '[REDACTED]',
      secret: '[REDACTED]',
      password: '[REDACTED]',
      accessToken: '[REDACTED]',
      refreshToken: '[REDACTED]',
      safe: 'ok',
    });
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'authorization',
        'cookie',
        '*.token',
        '*.secret',
        '*.password',
        '*.accessToken',
        '*.refreshToken',
      ]),
    );
  });

  it('15.4 honours the configured level and the base fields', () => {
    const { lines, stream } = sink();
    const log = createLogger({
      level: 'warn',
      destination: stream,
      base: { 'service.name': 'bastion-worker' },
    });
    log.info('no');
    log.warn('yes');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')['service.name']).toBe('bastion-worker');
  });

  it('15.4 defaults to stdout when no destination is given', () => {
    expect(() => createLogger({ level: 'silent' })).not.toThrow();
  });

  it('15.4 bridges records to OTEL logs with severity, body, attributes and trace ids', () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const { lines, stream } = sink();
    const log = createLogger({
      level: 'debug',
      destination: stream,
      otelLogger: provider.getLogger('bastion'),
    });
    log.error({ code: 'E1', nested: { a: 1 }, token: 'zzz' }, 'it broke');
    log.debug('dbg');
    expect(lines).toHaveLength(2);
    const [err, dbg] = exporter.getFinishedLogRecords();
    expect(err?.body).toBe('it broke');
    expect(err?.severityText).toBe('ERROR');
    expect(err?.attributes.code).toBe('E1');
    expect(err?.attributes.nested).toBe('{"a":1}');
    expect(err?.attributes.token).toBe('[REDACTED]');
    expect(dbg?.severityText).toBe('DEBUG');
    expect(
      createLogger({ level: 'silent', destination: stream, otelLogger: provider.getLogger('x') }),
    ).toBeDefined();
  });

  it('15.4 the OTEL log stream ignores malformed lines', () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    const out = createOtelLogStream(provider.getLogger('x'));
    out.write('not json');
    out.write('[1]');
    out.write('"s"');
    out.write(JSON.stringify({ level: 99, msg: 5, time: 1 }));
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.severityText).toBe('INFO');
    expect(records[0]?.body).toBe('');
  });
});

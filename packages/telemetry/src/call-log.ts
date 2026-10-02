/**
 * Call log (15.5): the `CallLogRow` mirror of `call_log` (16.2), preview redaction and the in-memory
 * batching writer.
 */
import { CALL_OUTCOMES, PRINCIPAL_TYPES } from '@bastion-mcp/core';
import { z } from 'zod';

export const MAX_PREVIEW_BYTES = 2048;
export const FLUSH_INTERVAL_MS = 500;
export const FLUSH_BATCH_SIZE = 500;
export const MAX_BUFFERED_ROWS = 50_000;

const uuid = z.string().uuid();
const jsonValue: z.ZodType<unknown> = z.unknown();

/** One `call_log` row (16.2). Previews are present only when the org enabled `logs.capturePreviews`. */
export const callLogRowSchema = z.object({
  id: uuid,
  ts: z.date(),
  durationMs: z.number().int().nonnegative(),
  principalType: z.enum(PRINCIPAL_TYPES),
  principalId: uuid,
  clientId: z.string().nullish(),
  clientName: z.string().nullish(),
  endpointId: uuid.nullish(),
  installationId: uuid.nullish(),
  catalogEntryId: uuid.nullish(),
  catalogVersionId: uuid.nullish(),
  method: z.string().min(1),
  itemName: z.string().nullish(),
  upstreamName: z.string().nullish(),
  outcome: z.enum(CALL_OUTCOMES),
  errorCode: z.string().nullish(),
  jsonrpcCode: z.number().int().nullish(),
  eraDown: z.string().min(1),
  eraUp: z.string().nullish(),
  coldStart: z.boolean().default(false),
  bytesIn: z.number().int().nonnegative().default(0),
  bytesOut: z.number().int().nonnegative().default(0),
  guardResults: jsonValue.optional(),
  policyReasons: jsonValue.optional(),
  argsPreview: jsonValue.optional(),
  resultPreview: jsonValue.optional(),
  traceId: z.string().nullish(),
  spanId: z.string().nullish(),
});

export type CallLogRow = z.infer<typeof callLogRowSchema>;
export type CallLogRowInput = z.input<typeof callLogRowSchema>;

export const parseCallLogRow = (value: unknown): CallLogRow => callLogRowSchema.parse(value);
export const safeParseCallLogRow = (value: unknown) => callLogRowSchema.safeParse(value);

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|accesstoken|refreshtoken|access_token|refresh_token|id_token|api[-_]?key|client_secret|private[-_]?key)$/i;
const MAX_DEPTH = 8;

/** Replace the values of sensitive keys; bounded depth. */
export const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
};

/** Redact, then cap the serialized size at 2 KiB; oversize values become `{truncated, preview}`. */
export const buildPreview = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  const redacted = redactValue(value);
  let text: string;
  try {
    text = JSON.stringify(redacted) ?? 'null';
  } catch {
    return { truncated: true, preview: '[unserializable]' };
  }
  if (Buffer.byteLength(text, 'utf8') <= MAX_PREVIEW_BYTES) return redacted;
  const sliced = Buffer.from(text, 'utf8')
    .subarray(0, MAX_PREVIEW_BYTES - 64)
    .toString('utf8');
  return { truncated: true, preview: sliced.replace(/�$/, '') };
};

/** Apply the preview policy: previews are dropped unless `capturePreviews` is true (15.5). */
export const applyPreviewPolicy = (row: CallLogRow, capturePreviews: boolean): CallLogRow => {
  const { argsPreview, resultPreview, ...rest } = row;
  if (!capturePreviews) return rest;
  return {
    ...rest,
    ...(argsPreview === undefined ? {} : { argsPreview: buildPreview(argsPreview) }),
    ...(resultPreview === undefined ? {} : { resultPreview: buildPreview(resultPreview) }),
  };
};

export type CallLogSink = (rows: CallLogRow[]) => Promise<void>;

export interface CallLogWriterOptions {
  /** Inserts one batch; must reject on failure. Supplied by `@bastion-mcp/db`. */
  sink: CallLogSink;
  /** Called with the number of rows dropped; wire to `bastion.calllog.dropped`. */
  onDropped: (count: number) => void;
  /** Org setting `logs.capturePreviews`; may be a function so a config change applies live. */
  capturePreviews?: boolean | (() => boolean) | undefined;
  onSinkError?: ((error: unknown, retryInMs: number) => void) | undefined;
  flushIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  maxBuffered?: number | undefined;
  backoffInitialMs?: number | undefined;
  backoffMaxMs?: number | undefined;
}

export class CallLogWriter {
  private buffer: CallLogRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private failures = 0;
  private closed = false;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBuffered: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;

  constructor(private readonly options: CallLogWriterOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.batchSize = options.batchSize ?? FLUSH_BATCH_SIZE;
    this.maxBuffered = options.maxBuffered ?? MAX_BUFFERED_ROWS;
    this.backoffInitialMs = options.backoffInitialMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Buffer a row. Never throws and never blocks the request path. */
  append(row: CallLogRow): void {
    if (this.closed) {
      this.options.onDropped(1);
      return;
    }
    const capture =
      typeof this.options.capturePreviews === 'function'
        ? this.options.capturePreviews()
        : (this.options.capturePreviews ?? false);
    this.buffer.push(applyPreviewPolicy(row, capture));
    this.trim();
    if (
      this.buffer.length >= this.batchSize &&
      this.failures === 0 &&
      this.inflight === undefined
    ) {
      void this.flush();
    } else {
      this.schedule(this.flushIntervalMs);
    }
  }

  /** Drop the oldest rows beyond the cap (15.5). */
  private trim(): void {
    const over = this.buffer.length - this.maxBuffered;
    if (over > 0) {
      this.buffer.splice(0, over);
      this.options.onDropped(over);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref();
  }

  /** Flush everything buffered, batch by batch. Resolves (never rejects); a failing sink keeps the rows. */
  async flush(): Promise<void> {
    while (this.inflight !== undefined) await this.inflight;
    this.inflight = this.drain().finally(() => {
      this.inflight = undefined;
    });
    await this.inflight;
  }

  private async drain(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      try {
        await this.options.sink(batch);
        this.failures = 0;
      } catch (error) {
        this.buffer.unshift(...batch);
        this.trim();
        this.failures += 1;
        const retryInMs = Math.min(
          this.backoffMaxMs,
          this.backoffInitialMs * 2 ** (this.failures - 1),
        );
        this.options.onSinkError?.(error, retryInMs);
        this.schedule(retryInMs);
        return;
      }
    }
  }

  /** Stop timers and drain once; rows the sink still refuses are counted as dropped. */
  async close(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length > 0) {
      this.options.onDropped(this.buffer.length);
      this.buffer = [];
    }
  }
}

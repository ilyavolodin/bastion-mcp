import { MAX_UPSTREAM_MESSAGE_BYTES, MAX_UPSTREAM_STREAM_BYTES, UpstreamUnavailableError } from '@bastion-mcp/core';
import { type Logger, noopLogger } from '../ports';

/**
 * Response caps of 8.9: 32 MiB per message and 100 MiB per stream. A larger response fails the in-flight
 * requests with `-32014` and is logged (6.9).
 */

export type CapOptions = {
  installation: string;
  messageBytes?: number;
  streamBytes?: number;
  logger?: Logger;
  onViolation?: (error: UpstreamUnavailableError) => void;
};

const BLANK_LINE = [Buffer.from('\n\n'), Buffer.from('\r\n\r\n'), Buffer.from('\r\r')];

/** Index just past the last SSE event terminator in `buffer`, or -1. */
export const lastEventBoundary = (buffer: Buffer): number => {
  let best = -1;
  for (const terminator of BLANK_LINE) {
    const at = buffer.lastIndexOf(terminator);
    if (at >= 0) best = Math.max(best, at + terminator.length);
  }
  return best;
};

export class CapTracker {
  violation: UpstreamUnavailableError | undefined;
  private readonly messageBytes: number;
  private readonly streamBytes: number;
  private readonly logger: Logger;

  constructor(private readonly options: CapOptions) {
    this.messageBytes = options.messageBytes ?? MAX_UPSTREAM_MESSAGE_BYTES;
    this.streamBytes = options.streamBytes ?? MAX_UPSTREAM_STREAM_BYTES;
    this.logger = options.logger ?? noopLogger;
  }

  private fail(what: string, limit: number): UpstreamUnavailableError {
    const error = new UpstreamUnavailableError(
      `upstream ${what} exceeds the ${limit} byte limit`,
      { installation: this.options.installation },
    );
    this.violation ??= error;
    this.logger.error('upstream response cap exceeded', {
      installation: this.options.installation,
      what,
      limit,
    });
    this.options.onViolation?.(error);
    return error;
  }

  /** Wraps a response so oversized bodies error out instead of being buffered without bound. */
  wrap(response: Response): Response {
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    if (!isStream && Number.isFinite(declared) && declared > this.messageBytes) {
      void response.body?.cancel().catch(() => undefined);
      const error = this.fail('message', this.messageBytes);
      return new Response(
        new ReadableStream({
          start: (controller) => controller.error(error),
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    }
    if (!response.body) return response;
    let total = 0;
    let event = 0;
    let tail: Buffer = Buffer.alloc(0);
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        total += chunk.length;
        if (isStream) {
          const view = Buffer.concat([tail, Buffer.from(chunk)]);
          const boundary = lastEventBoundary(view);
          event = boundary >= 0 ? view.length - boundary : event + chunk.length;
          tail = view.subarray(Math.max(0, view.length - 3));
          if (total > this.streamBytes) return controller.error(this.fail('stream', this.streamBytes));
          if (event > this.messageBytes) return controller.error(this.fail('message', this.messageBytes));
        } else if (total > this.messageBytes) {
          return controller.error(this.fail('message', this.messageBytes));
        }
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

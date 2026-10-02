import type { ServerResponse } from 'node:http';

/** One SSE response (6.2). No event ids are ever written and `Last-Event-ID` is ignored. */
export class SseStream {
  private ended = false;
  private readonly closeListeners: (() => void)[] = [];

  constructor(readonly res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    res.on('close', () => this.markClosed());
  }

  private markClosed(): void {
    if (this.ended) return;
    this.ended = true;
    for (const l of this.closeListeners.splice(0)) l();
  }

  get closed(): boolean {
    return this.ended || this.res.destroyed;
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  write(message: unknown): void {
    if (this.closed) return;
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.ended = true;
    this.res.end();
    for (const l of this.closeListeners.splice(0)) l();
  }
}

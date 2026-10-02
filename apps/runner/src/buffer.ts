/**
 * Output buffer used while no WebSocket is connected (8.3): at most 1,000 entries or 4 MiB, dropping the
 * oldest first and counting what was dropped so the counter can be reported on reconnect.
 */
export const MAX_BUFFERED_MESSAGES = 1_000;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export class OutputBuffer {
  private items: { frame: string; bytes: number }[] = [];
  private bytes = 0;
  private droppedCount = 0;

  constructor(
    private readonly maxMessages = MAX_BUFFERED_MESSAGES,
    private readonly maxBytes = MAX_BUFFERED_BYTES,
  ) {}

  get size(): number {
    return this.items.length;
  }
  get byteSize(): number {
    return this.bytes;
  }
  get dropped(): number {
    return this.droppedCount;
  }

  push(frame: string): void {
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.maxBytes) {
      this.droppedCount += 1;
      return;
    }
    this.items.push({ frame, bytes });
    this.bytes += bytes;
    while (this.items.length > this.maxMessages || this.bytes > this.maxBytes) {
      const oldest = this.items.shift();
      if (!oldest) break;
      this.bytes -= oldest.bytes;
      this.droppedCount += 1;
    }
  }

  /** Returns every buffered frame in order and the dropped counter, then resets both. */
  drain(): { frames: string[]; dropped: number } {
    const result = { frames: this.items.map((i) => i.frame), dropped: this.droppedCount };
    this.items = [];
    this.bytes = 0;
    this.droppedCount = 0;
    return result;
  }
}

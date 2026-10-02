import { StringDecoder } from 'node:string_decoder';
import { isJsonRpcMessage, type JsonObject } from '@bastion-mcp/sandbox/protocol';

/** Incremental `\n` splitter for server stdout (8.3). Handles split UTF-8 and `\r\n`. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private overflowed = false;

  constructor(private readonly maxLineChars = 33 * 1024 * 1024) {}

  /** Feeds a chunk and returns the complete lines. An over-long line is cut and reported once. */
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let nl = this.pending.indexOf('\n');
    while (nl >= 0) {
      const line = this.pending.slice(0, nl).replace(/\r$/, '');
      this.pending = this.pending.slice(nl + 1);
      if (this.overflowed) this.overflowed = false;
      else lines.push(line);
      nl = this.pending.indexOf('\n');
    }
    if (this.pending.length > this.maxLineChars) {
      lines.push(this.pending.slice(0, 8192));
      this.pending = '';
      this.overflowed = true;
    }
    return lines;
  }

  /** The unterminated tail at end of stream. */
  flush(): string | undefined {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    return rest.length > 0 && !this.overflowed ? rest.replace(/\r$/, '') : undefined;
  }
}

export type StdoutLine =
  | { kind: 'message'; message: JsonObject }
  | { kind: 'stderr'; text: string }
  | { kind: 'blank' };

/** JSON-RPC lines are messages; anything else on stdout is treated as stderr (8.3). */
export const classifyStdoutLine = (line: string): StdoutLine => {
  if (line.trim() === '') return { kind: 'blank' };
  try {
    const value: unknown = JSON.parse(line);
    if (isJsonRpcMessage(value)) return { kind: 'message', message: value };
  } catch {
    // not JSON: falls through to stderr
  }
  return { kind: 'stderr', text: line };
};

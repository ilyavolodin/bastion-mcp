import type { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import type { z } from 'zod';
import { isJsonRpcMessage, type JsonObject } from './protocol';
import type { StdioChannel } from './types';

/** JSON-RPC message as the SDK types it (`@modelcontextprotocol/core` 2.2.0 exports the zod schema). */
export type JSONRPCMessage = z.infer<typeof JSONRPCMessageSchema>;

/**
 * Structural twin of the SDK `Transport` (declared in `@modelcontextprotocol/client|server`, which `sandbox`
 * must not depend on). `Client.connect(transport)` accepts it because the member types are identical.
 */
export interface SdkTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: unknown): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: unknown) => void) | undefined;
  sessionId?: string | undefined;
}

/**
 * Custom SDK transport over the runner WebSocket (6.4, 8.3): `send` writes `m` frames, `onmessage` receives
 * them. An `x` frame (server exit) closes the transport; a close with 4001 means another owner took over.
 */
export class SandboxStdioTransport implements SdkTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: unknown) => void) | undefined;
  sessionId?: string | undefined;
  /** Set once an `x` frame arrived; the instance manager maps it to `-32014` (8.6). */
  exit: { code: number | null; signal: string | null } | undefined;
  /** Close code of the WebSocket, when it closed (4001 = replaced). */
  closeCode: number | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly channel: StdioChannel,
    private readonly options: { onStderr?: (line: string) => void } = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('SandboxStdioTransport already started');
    this.started = true;
    this.channel.handlers = {
      onmessage: (message: JsonObject) => {
        if (!isJsonRpcMessage(message)) return;
        this.onmessage?.(message as unknown as JSONRPCMessage);
      },
      onstderr: (line) => this.options.onStderr?.(line),
      onexit: (exit) => {
        this.exit = exit;
        this.onerror?.(
          new Error(`sandboxed server exited (code ${exit.code}, signal ${exit.signal})`),
        );
        this.finish();
      },
      onclose: ({ code }) => {
        this.closeCode = code;
        this.finish();
      },
      onerror: (error) => this.onerror?.(error),
    };
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('SandboxStdioTransport is closed');
    await this.channel.send(message as unknown as JsonObject);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.channel.close();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

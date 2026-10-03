import type { SandboxSize } from '@bastion-mcp/core';
import type { JsonObject, StartEvent, StartRequestInput } from './protocol';

/** Driver and handle contracts of 8.2. */

export type SandboxDriverName = 'kubernetes' | 'bubblewrap';
export type IsolationLevel = 'gvisor' | 'kata' | 'namespaces';

export type SandboxRef = {
  driver: SandboxDriverName;
  /** Claim name (`bst-...`, `bsp-...`) or instance id. */
  id: string;
  /** `host:port` of the runner, or `unix:<path>`. */
  address: string;
  /**
   * Runner bearer token chosen at `create` (8.3). The instance manager persists it (encrypted) with
   * the instance row so a new owner can `attach` after an owner change (21.2).
   */
  runnerToken: string;
};

export type SandboxSpec = {
  instanceId: string;
  /** Null for shared pools (8.6). */
  installationId: string | null;
  userId: string | null;
  size: SandboxSize;
  workspace: { persistent: boolean; sizeMiB: number };
  /** Optional minimum isolation (`minIsolation`, 8.5). */
  minIsolation?: IsolationLevel;
};

export type StdioHandlers = {
  onmessage?: (message: JsonObject) => void;
  onstderr?: (line: string) => void;
  /** Server process exit (an `x` frame). */
  onexit?: (exit: { code: number | null; signal: string | null }) => void;
  /** The WebSocket closed; `code` 4001 means a newer owner replaced this connection. */
  onclose?: (info: { code: number; reason: string }) => void;
  onerror?: (error: Error) => void;
};

export interface StdioChannel {
  /** Messages the runner dropped while no WebSocket was connected (8.3). */
  readonly dropped: number;
  handlers: StdioHandlers;
  send(message: JsonObject): Promise<void>;
  close(): Promise<void>;
}

export interface RunnerClient {
  health(signal?: AbortSignal): Promise<{ state: 'unbound' | 'bound' | 'running' }>;
  /** Accepted exactly once per runner; the client keeps the token for later calls. */
  bind(token: string, signal?: AbortSignal): Promise<void>;
  /** Streams NDJSON phase events until `ready` or `failed`. */
  start(request: StartRequestInput, signal?: AbortSignal): AsyncIterable<StartEvent>;
  stop(signal?: AbortSignal): Promise<void>;
  /** Opens the stdio WebSocket. A new connection replaces any previous one (closed with 4001). */
  openStdio(signal?: AbortSignal): Promise<StdioChannel>;
  /** Adopt a token without binding, for `attach` after an owner change. */
  useToken(token: string): void;
}

export interface SandboxHandle {
  ref: SandboxRef;
  runner: RunnerClient;
}

export interface SandboxDriver {
  readonly name: SandboxDriverName;
  readonly isolation: IsolationLevel;
  create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle>;
  attach(ref: SandboxRef, signal: AbortSignal): Promise<SandboxHandle>;
  suspend(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef): Promise<void>;
  list(): AsyncIterable<SandboxRef>;
}

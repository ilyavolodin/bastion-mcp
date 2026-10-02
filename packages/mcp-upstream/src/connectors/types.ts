import type { Era } from '@bastion-mcp/core';
import type { StdioChannel } from '@bastion-mcp/sandbox';
import type { PriorDiscovery } from '@modelcontextprotocol/client';
import type { ContinuationRegistry } from '../input-required/registry';
import type {
  CallPrincipal,
  RemoteSessionRecord,
  ResolvedCredential,
  ResolvedInstallation,
} from '../ports';
import type {
  JsonObject,
  SessionOutcome,
  UpstreamCallContext,
  UpstreamNotification,
} from '../types';

export type OpOptions = {
  ctx: UpstreamCallContext;
  /** Overrides the per-method default (6.4); the call deadline still caps it. */
  timeoutMs?: number | undefined;
};

export type CloseInfo = {
  /** The runner `x` frame: the sandboxed server exited (8.6). */
  exit?: { code: number | null; signal: string | null } | undefined;
  /** WebSocket close code, 4001 meaning another owner took over (21.2). */
  closeCode?: number | undefined;
  error?: Error | undefined;
};

export interface UpstreamSubscription {
  close(): Promise<void>;
  readonly closed: Promise<'local' | 'graceful' | 'remote'>;
}

export type ListenFilter = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
};

/**
 * One live connection to an upstream (6.4). Every operation returns the OpOutcome shape of 6.2 and passes
 * `allowInputRequired: true` with `autoFulfill: false` to the SDK.
 */
export interface UpstreamSession {
  readonly era: Era;
  readonly protocolVersion: string | undefined;
  /** `Mcp-Session-Id` of a legacy remote session (21.2). */
  readonly sessionId: string | undefined;
  readonly serverCapabilities: JsonObject;
  readonly serverInfo: { name: string; version: string; title?: string } | undefined;
  readonly instructions: string | undefined;
  readonly closed: boolean;

  request(method: string, params: JsonObject, options: OpOptions): Promise<SessionOutcome>;
  callTool(params: JsonObject, options: OpOptions): Promise<SessionOutcome>;
  getPrompt(params: JsonObject, options: OpOptions): Promise<SessionOutcome>;
  readResource(params: JsonObject, options: OpOptions): Promise<SessionOutcome>;
  complete(params: JsonObject, options: OpOptions): Promise<SessionOutcome>;
  listTools(params: JsonObject, options: OpOptions): Promise<JsonObject>;
  listPrompts(params: JsonObject, options: OpOptions): Promise<JsonObject>;
  listResources(params: JsonObject, options: OpOptions): Promise<JsonObject>;
  listResourceTemplates(params: JsonObject, options: OpOptions): Promise<JsonObject>;
  subscribe(uri: string, options: OpOptions): Promise<void>;
  unsubscribe(uri: string, options: OpOptions): Promise<void>;
  ping(options: OpOptions): Promise<void>;
  /** Modern upstreams only: one `subscriptions/listen` stream (6.6). */
  listen(filter: ListenFilter, options: OpOptions): Promise<UpstreamSubscription>;
  /** Continues a legacy upstream call that ended with `input_required` (6.5). */
  resumeContinuation(
    continuationId: string,
    inputResponses: Record<string, unknown>,
    options: OpOptions,
  ): Promise<SessionOutcome>;
  hasContinuation(continuationId: string): boolean;
  /** Upstream notifications that are not tied to a request: list_changed, resources/updated (6.6). */
  onNotification(handler: (notification: UpstreamNotification) => void): () => void;
  onClose(handler: (info: CloseInfo) => void): void;
  close(): Promise<void>;
}

export type ConnectContext = {
  installation: ResolvedInstallation;
  principal: CallPrincipal;
  credential: ResolvedCredential;
  /** Row id: the lease key for stateful connections, the era cache subject otherwise. */
  instanceId: string;
  signal: AbortSignal;
  /** Era verdict from the Redis cache: only the first connection per credential probes (6.4). */
  prior?: PriorDiscovery | undefined;
  /** A stored legacy remote session to resume instead of `initialize` (21.2). */
  remoteSession?: RemoteSessionRecord | undefined;
  /** Where legacy-upstream continuations of this connection are recorded (6.5). */
  continuations?: ContinuationRegistry | undefined;
  /** Sandbox stdio: the runner channel and the stderr sink of this instance (8.3, 8.7). */
  sandbox?: { channel: StdioChannel; onStderr?: ((line: string) => void) | undefined } | undefined;
  /** Called with the era the connection ended up in, so the caller can cache the verdict (6.4). */
  onVerdict?: ((verdict: PriorDiscovery) => void) | undefined;
};

export interface UpstreamConnector {
  connect(ctx: ConnectContext): Promise<UpstreamSession>;
}

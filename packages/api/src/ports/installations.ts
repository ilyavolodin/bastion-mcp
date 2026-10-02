import type { UpstreamItems } from '@bastion-mcp/router';

/** Where the router reads an installation's upstream definitions for `compileEndpoint` (7.2). */
export interface UpstreamDefinitionPort {
  listItems(
    installationId: string,
    principalId: string,
    signal?: AbortSignal,
  ): Promise<{ status: 'ok'; items: UpstreamItems } | { status: 'degraded'; code: string }>;
}

/** Starts the upstream OAuth flow for an installation (11.5); returns the authorization URL. */
export interface UpstreamConnectPort {
  begin(input: {
    installationId: string;
    principalId: string;
    returnTo?: string;
  }): Promise<{ authorizationUrl: string }>;
  disconnect(input: { installationId: string; principalId: string }): Promise<void>;
}

export type TryRequest =
  | { kind: 'tool'; name: string; arguments?: Record<string, unknown> | undefined }
  | { kind: 'prompt'; name: string; arguments?: Record<string, string> | undefined }
  | { kind: 'resource'; uri: string };

/** Runs a call through the full pipeline (policy, guards, limits, overrides) as the caller (11.4). */
export interface TryPort {
  run(input: {
    installationId: string;
    principalId: string;
    request: TryRequest;
    signal?: AbortSignal;
  }): Promise<{ result: unknown; isError: boolean; durationMs: number; callId: string | null }>;
}

export type EgressEntry = {
  ts: string;
  host: string;
  port: number;
  decision: 'allowed' | 'denied';
  bytesOut?: number;
};

export interface InstallationRuntimePort {
  restart(installationId: string): Promise<void>;
  /** Stops the installation's instance and releases its lease; used before the installation row is deleted. */
  stop(installationId: string): Promise<void>;
  /** Last `tail` lines of stderr, oldest first. */
  logTail(installationId: string, tail: number): Promise<string[]>;
  egress(installationId: string, limit: number): Promise<EgressEntry[]>;
}

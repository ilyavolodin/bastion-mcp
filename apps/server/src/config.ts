import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { type BastionConfig, ConfigError, loadConfig, parseConfigFile } from '@bastion-mcp/core';

export const SERVER_VERSION = process.env.BASTION_VERSION ?? '0.1.0';

/** `BASTION_CONFIG_FILE` (optional) merged under the environment (19.1). Throws `ConfigError` with every issue. */
export const loadServerConfig = (env: Record<string, string | undefined>): BastionConfig => {
  const file = env.BASTION_CONFIG_FILE;
  const values = file ? parseConfigFile(readFileSync(file, 'utf8')) : {};
  return loadConfig(env, values);
};

/** Prints every error and exits non-zero (used by the CLI and `main`). */
export const loadConfigOrExit = (env: Record<string, string | undefined>): BastionConfig => {
  try {
    return loadServerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const issue of error.issues)
        console.error(`config error: ${issue.path}: ${issue.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
};

export const defaultWorkerId = (env: Record<string, string | undefined>): string =>
  env.BASTION_WORKER_ID ?? `${hostname()}-${process.pid}`;

export const publicHost = (config: BastionConfig): string => new URL(config.publicUrl).host;

/**
 * Knobs that are not deployment configuration: tests and embedders set them. Production reads none of them.
 */
export type ServerOptions = {
  /** Worker id for the registry; defaults to `BASTION_WORKER_ID` or `<hostname>-<pid>`. */
  workerId?: string;
  /** `127.0.0.1` in tests; defaults to `0.0.0.0`. */
  listenHost?: string;
  /** Port for the internal RPC listener address advertised in the worker registry. Defaults to config. */
  advertiseHost?: string;
  /** Lets openid-client call `http://` IdPs and upstream authorization servers (tests only). */
  allowInsecureHttp?: boolean;
  /** Replaces the global fetch for IdP, CIMD and upstream OAuth calls. */
  fetch?: typeof fetch;
  /** Sandbox driver override (tests: a `LocalProcessDriver`). */
  sandboxDriver?: import('@bastion-mcp/sandbox').SandboxDriver;
  /** Where pino writes; defaults to stdout. */
  logDestination?: import('pino').DestinationStream;
  /** Skip the pending-migrations check (the CLI `migrate` itself never boots the server). */
  skipMigrationCheck?: boolean;
  /** Run the scheduler even when the role is not ui; `false` disables it for the ui role. */
  scheduler?: boolean;
  /** Public path for CORS allowed origins besides the public URL. */
  extraCorsOrigins?: string[];
  /** SSE keep-alive for MCP streams. */
  keepAliveMs?: number;
  /** Idle sweep and similar timing knobs for tests. */
  timing?: { instanceIdleMs?: number; workerHeartbeatMs?: number };
  /** Extra health checks for tests. */
  printBootstrapPassword?: (email: string, password: string) => void;
  /** Static asset directory; defaults to `public` next to the bundle. */
  publicDir?: string;
};

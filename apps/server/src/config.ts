import { readFileSync } from 'node:fs';
import { type BastionConfig, ConfigError, loadConfig, parseConfigFile } from '@bastion-mcp/core';
import { DEFAULT_SERVER_VERSION, defaultWorkerId } from './resource-env';

type EnvSource = Record<string, string | undefined>;

export { DEFAULT_SERVER_VERSION, defaultWorkerId };

/** The version this process reports to upstreams and in the worker registry (`BASTION_VERSION` or the default). */
export const serverVersion = (config: Pick<BastionConfig, 'version'>): string =>
  config.version ?? DEFAULT_SERVER_VERSION;

/**
 * Process-level settings read from the environment that are not part of `BastionConfig`: where the sandbox runner
 * and its runtime live, the host sandboxes use to reach the egress proxy, and the static asset directory.
 */
export type ServerEnv = {
  egressHost: string | undefined;
  runnerPath: string;
  runtimeDir: string;
  publicDir: string | undefined;
};

export const readServerEnv = (env: EnvSource): ServerEnv => ({
  egressHost: env.BASTION_EGRESS_HOST || undefined,
  runnerPath: env.BASTION_RUNNER_PATH || '/opt/bastion/runner.mjs',
  runtimeDir: env.BASTION_RUNTIME_DIR || '/opt/runtime',
  publicDir: env.BASTION_PUBLIC_DIR || undefined,
});

export const isProduction = (env: EnvSource): boolean => env.NODE_ENV === 'production';

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

export const publicHost = (config: BastionConfig): string => new URL(config.publicUrl).host;

/** Scheme and host as clients reach Bastion (`http://localhost:8080` in an evaluation): the base of every OAuth URL. */
export const publicOrigin = (config: BastionConfig): string => new URL(config.publicUrl).origin;

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

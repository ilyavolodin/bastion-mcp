import { hostname } from 'node:os';

/**
 * Environment-derived process identity, kept free of imports beyond `node:os` so `otel.ts` can use it before the
 * OpenTelemetry SDK starts without loading the rest of the server.
 */
type EnvSource = Record<string, string | undefined>;

export const DEFAULT_SERVER_VERSION = '0.1.0';

export const defaultWorkerId = (env: EnvSource): string =>
  env.BASTION_WORKER_ID ?? `${hostname()}-${process.pid}`;

/**
 * Defaults for the resource attributes the telemetry package reads from the environment. `otel.ts` applies them
 * before the SDK starts, so spans carry the same version, environment and worker id as the logs.
 */
export const resourceDefaults = (env: EnvSource): Record<string, string> => ({
  BASTION_VERSION: env.BASTION_VERSION ?? DEFAULT_SERVER_VERSION,
  BASTION_ENVIRONMENT: env.BASTION_ENVIRONMENT ?? env.NODE_ENV ?? 'production',
  BASTION_WORKER_ID: defaultWorkerId(env),
});

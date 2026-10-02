/**
 * Entry for `node --import @bastion-mcp/telemetry/otel-register` (15.1): starts the OpenTelemetry SDK before
 * any other module loads, so instrumentations can patch http, undici, fastify, pg, ioredis and pino.
 */
import { startOtelFromEnv } from './otel';

export const otelHandle = startOtelFromEnv();

if (otelHandle !== null) {
  const stop = (): void => {
    // An unreachable collector must never crash the process on the way out.
    otelHandle.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('beforeExit', stop);
}

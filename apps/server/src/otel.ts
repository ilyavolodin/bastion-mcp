/**
 * `node --import ./dist/otel.js ./dist/main.js` (15.1): starts the OpenTelemetry SDK before any other module loads,
 * after setting the resource defaults the telemetry package reads from the environment.
 */
import { hostname } from 'node:os';

process.env.BASTION_VERSION ??= '0.1.0';
process.env.BASTION_ENVIRONMENT ??= process.env.NODE_ENV ?? 'production';
process.env.BASTION_WORKER_ID ??= `${hostname()}-${process.pid}`;

await import('@bastion-mcp/telemetry/otel-register');

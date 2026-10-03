/**
 * `node --import ./dist/otel.js ./dist/main.js` (15.1): starts the OpenTelemetry SDK before any other module loads,
 * after setting the resource defaults the telemetry package reads from the environment.
 */
import { resourceDefaults } from './resource-env';

for (const [key, value] of Object.entries(resourceDefaults(process.env)))
  process.env[key] ??= value;

await import('@bastion-mcp/telemetry/otel-register');

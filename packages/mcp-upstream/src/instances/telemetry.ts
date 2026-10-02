import { type INSTANCE_ACQUIRE_EVENTS, SPAN_NAMES } from '@bastion-mcp/telemetry';
import { SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

export type AcquireEventName = (typeof INSTANCE_ACQUIRE_EVENTS)[number];
export type AcquireEvents = { add(name: AcquireEventName): void };

/**
 * `bastion.instance.acquire` span with the events `claimed`, `bound`, `installed`, `spawned`, `connected`
 * (15.2). A port so tests can observe the events without an OpenTelemetry SDK.
 */
export interface InstanceTelemetry {
  acquire<T>(
    attributes: Record<string, string | number | boolean>,
    fn: (events: AcquireEvents) => Promise<T>,
  ): Promise<T>;
}

export const otelInstanceTelemetry = (
  tracer: Tracer = trace.getTracer('bastion-mcp-upstream'),
): InstanceTelemetry => ({
  acquire: (attributes, fn) =>
    tracer.startActiveSpan(SPAN_NAMES.instanceAcquire, { attributes }, async (span) => {
      try {
        return await fn({ add: (name) => void span.addEvent(name) });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        throw error;
      } finally {
        span.end();
      }
    }),
});

export const noopInstanceTelemetry: InstanceTelemetry = {
  acquire: (_attributes, fn) => fn({ add: () => undefined }),
};

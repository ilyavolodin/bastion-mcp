import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceCarrier } from '../types';

/**
 * The trace carrier of the request being sent. Remote transports are created once per connection, so the fetch
 * wrapper reads the per-request `traceparent`, `tracestate` and `baggage` headers from here (6.4).
 */
export const traceStorage = new AsyncLocalStorage<TraceCarrier>();

export const runWithTrace = <T>(trace: TraceCarrier, fn: () => T): T => traceStorage.run(trace, fn);

import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/** `bastion.upstream.oauth.refreshes{outcome}` (15.3). The telemetry package supplies the real counter. */
export type RefreshOutcome = 'success' | 'failure' | 'reconnect_required';
export type OAuthMetrics = { recordRefresh(outcome: RefreshOutcome): void };
export const noopMetrics: OAuthMetrics = { recordRefresh: () => {} };

/** Runs `fn` in a `bastion.oauth.refresh` span (global OpenTelemetry API; a no-op without an SDK). */
export const withRefreshSpan = <T>(
  attributes: Record<string, string>,
  fn: (span: Span) => Promise<T>,
): Promise<T> =>
  trace
    .getTracer('bastion-auth')
    .startActiveSpan('bastion.oauth.refresh', { attributes }, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });

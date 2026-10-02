/** What every routed operation does when it ends: the call-log row, `bastion.calls` and the span outcome (15.2, 15.3, 15.5). */
import type { InstallationInfo } from '@bastion-mcp/router';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { type CallRecord, writeCallLog } from '../observability/call-log';
import type { OpContext } from '../types';
import type { OperationDeps } from './deps';

export const recordOperationOutcome = (
  deps: OperationDeps,
  ctx: OpContext,
  record: CallRecord,
  span: { traceId: string; spanId: string },
  installation: InstallationInfo | undefined,
  method: string,
): void => {
  const active: Span | undefined = trace.getActiveSpan();
  active?.setAttribute('bastion.call.outcome', record.outcome);
  if (record.outcome === 'error' || record.outcome === 'denied' || record.outcome === 'blocked') {
    active?.setStatus({ code: SpanStatusCode.ERROR, message: record.errorCode ?? record.outcome });
  }
  try {
    deps.metrics.calls.add(1, {
      'bastion.catalog.entry': installation
        ? (installation.catalogSlug ?? installation.catalogEntryId)
        : 'unknown',
      outcome: record.outcome,
    });
  } catch (error) {
    deps.logger.warn('metric could not be recorded', { method, error: String(error) });
  }
  writeCallLog(
    { callLog: deps.callLog, logger: deps.logger, newId: deps.newId, now: () => deps.clock.now() },
    ctx,
    record,
    span,
  );
};

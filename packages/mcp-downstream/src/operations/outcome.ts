/** What every routed operation does when it ends: the call-log row, `bastion.calls` and the span outcome (15.2, 15.3, 15.5). */
import { SPAN_ATTRS } from '@bastion-mcp/mcp-upstream';
import type { InstallationInfo } from '@bastion-mcp/router';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { CallRecord, writeCallLog } from '../observability/call-log';
import type { OpContext } from '../types';
import type { OperationDeps } from './deps';
import { spanContextOf } from './support';

const UNKNOWN_ENTRY = 'unknown';

/** Outcomes that mark the active span as failed. */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set(['error', 'denied', 'blocked']);

/** `bastion.calls` labels for one finished operation (15.3). */
export const callMetricLabels = (
  record: Pick<CallRecord, 'outcome'>,
  installation: InstallationInfo | undefined,
): { [SPAN_ATTRS.catalogEntry]: string; outcome: string } => ({
  [SPAN_ATTRS.catalogEntry]: installation
    ? (installation.catalogSlug ?? installation.catalogEntryId)
    : UNKNOWN_ENTRY,
  outcome: record.outcome,
});

/** Span status for an outcome: an error status for failed outcomes, nothing otherwise. */
export const spanStatusFor = (
  record: Pick<CallRecord, 'outcome' | 'errorCode'>,
): { code: SpanStatusCode; message: string } | undefined =>
  FAILED_OUTCOMES.has(record.outcome)
    ? { code: SpanStatusCode.ERROR, message: record.errorCode ?? record.outcome }
    : undefined;

export const recordOperationOutcome = (
  deps: OperationDeps,
  ctx: OpContext,
  record: CallRecord,
  span: { traceId: string; spanId: string },
  installation: InstallationInfo | undefined,
  method: string,
): void => {
  const active: Span | undefined = trace.getActiveSpan();
  active?.setAttribute(SPAN_ATTRS.callOutcome, record.outcome);
  const status = spanStatusFor(record);
  if (status) active?.setStatus(status);
  try {
    deps.metrics.calls.add(1, callMetricLabels(record, installation));
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

/**
 * The scaffold every operation that reaches an installation shares: a call record primed with the installation, the
 * body, failure classification and the row/metric/span outcome in a `finally`. `onError` may turn a failure into a
 * result (tool calls answer denials as results, 6.9); returning `undefined` rethrows.
 */
export const runRoutedOperation = async <T>(
  deps: OperationDeps,
  ctx: OpContext,
  method: string,
  installation: InstallationInfo,
  body: (record: CallRecord) => Promise<T>,
  options: { itemName?: string; onError?: (error: unknown) => T | undefined } = {},
): Promise<T> => {
  const record = new CallRecord(method, deps.clock.now());
  const span = spanContextOf(ctx);
  record.installationId = installation.id;
  record.catalogEntryId = installation.catalogEntryId;
  record.catalogVersionId = installation.catalogVersionId;
  if (options.itemName !== undefined) record.itemName = options.itemName;
  try {
    return await body(record);
  } catch (error) {
    record.fail(error);
    const converted = options.onError?.(error);
    if (converted !== undefined) return converted;
    throw error;
  } finally {
    recordOperationOutcome(deps, ctx, record, span, installation, method);
  }
};

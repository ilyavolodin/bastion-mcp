/** One `call_log` row per operation that reaches routing (15.5), built from what the operation recorded. */
import type { CallOutcome } from '@bastion-mcp/core';
import { BastionError } from '@bastion-mcp/core';
import type { GuardResultRecord } from '@bastion-mcp/guards';
import type { CallLogRow } from '@bastion-mcp/telemetry';
import { safeParseCallLogRow } from '@bastion-mcp/telemetry';
import { z } from 'zod';
import type { CallLogPort, Logger } from '../ports';
import type { OpContext } from '../types';

const uuid = z.string().uuid();
const uuidOrNull = (value: string | undefined): string | null =>
  value !== undefined && uuid.safeParse(value).success ? value : null;

/** Everything one operation learns while it runs; turned into a row exactly once, in a `finally`. */
export class CallRecord {
  outcome: CallOutcome = 'ok';
  errorCode: string | undefined;
  jsonrpcCode: number | undefined;
  installationId: string | undefined;
  catalogEntryId: string | undefined;
  catalogVersionId: string | undefined;
  itemName: string | undefined;
  upstreamName: string | undefined;
  eraUp: string | undefined;
  coldStart = false;
  bytesIn = 0;
  bytesOut = 0;
  guardResults: GuardResultRecord[] = [];
  policyReasons: string[] | undefined;
  argsPreview: unknown;
  resultPreview: unknown;
  /** Set by tasks: the final task status goes into the preview of the one row per task (6.8). */
  readonly startedAt: number;
  /** Set when an operation decides its row would be noise (a non-terminal `tasks/get` poll). */
  skipLog = false;

  constructor(
    readonly method: string,
    startedAt: number,
  ) {
    this.startedAt = startedAt;
  }

  /** Classifies a failure into the call-log outcome vocabulary (15.5). */
  fail(error: unknown): void {
    if (error instanceof BastionError) {
      this.errorCode = error.code;
      this.jsonrpcCode = error.mcpCode;
      switch (error.code) {
        case 'POLICY_DENIED':
          this.outcome = 'denied';
          return;
        case 'RATE_LIMITED':
        case 'QUOTA_EXCEEDED':
          this.outcome = 'rate_limited';
          return;
        case 'GUARD_BLOCKED':
          this.outcome = 'blocked';
          return;
        default:
          this.outcome = 'error';
          return;
      }
    }
    this.errorCode = 'INTERNAL_ERROR';
    this.outcome = 'error';
  }
}

const sizeOf = (value: unknown): number => {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
};
export const byteSize = sizeOf;

export type CallLogDeps = {
  callLog: CallLogPort;
  logger: Logger;
  newId: () => string;
  now: () => number;
};

/** Appends the row; never throws and never blocks the request path (15.5). */
export const writeCallLog = (
  deps: CallLogDeps,
  ctx: OpContext,
  record: CallRecord,
  span: { traceId: string; spanId: string },
): void => {
  try {
    const endedAt = deps.now();
    const candidate = {
      id: deps.newId(),
      ts: new Date(record.startedAt),
      durationMs: Math.max(0, Math.round(endedAt - record.startedAt)),
      principalType: ctx.principal.type,
      principalId: ctx.principal.id,
      clientId: ctx.principal.clientId,
      clientName: ctx.clientInfo?.name ?? null,
      endpointId: uuidOrNull(ctx.endpoint.endpointId),
      installationId: uuidOrNull(record.installationId),
      catalogEntryId: uuidOrNull(record.catalogEntryId),
      catalogVersionId: uuidOrNull(record.catalogVersionId),
      method: record.method,
      itemName: record.itemName ?? null,
      upstreamName: record.upstreamName ?? null,
      outcome: record.outcome,
      errorCode: record.errorCode ?? null,
      jsonrpcCode: record.jsonrpcCode ?? null,
      eraDown: ctx.era,
      eraUp: record.eraUp ?? null,
      coldStart: record.coldStart,
      bytesIn: record.bytesIn,
      bytesOut: record.bytesOut,
      ...(record.guardResults.length > 0 ? { guardResults: record.guardResults } : {}),
      ...(record.policyReasons === undefined ? {} : { policyReasons: record.policyReasons }),
      ...(record.argsPreview === undefined ? {} : { argsPreview: record.argsPreview }),
      ...(record.resultPreview === undefined ? {} : { resultPreview: record.resultPreview }),
      traceId: span.traceId,
      spanId: span.spanId,
    };
    const parsed = safeParseCallLogRow(candidate);
    if (!parsed.success) {
      deps.logger.warn('call log row dropped: it does not satisfy the call_log schema', {
        method: record.method,
        issues: parsed.error.issues.map((i) => i.path.join('.')),
      });
      return;
    }
    const row: CallLogRow = parsed.data;
    deps.callLog.append(row);
  } catch (error) {
    deps.logger.warn('call log row could not be written', { error: String(error) });
  }
};

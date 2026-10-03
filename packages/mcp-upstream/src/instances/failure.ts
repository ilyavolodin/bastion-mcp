import { isInstallationError, recordFailure } from '@bastion-mcp/sandbox';
import type { InstanceRecord } from '../ports';

/** Awaits a best-effort call whose failure must not mask the one being handled. */
export const swallow = async <T>(work: Promise<T>): Promise<T | undefined> =>
  work.catch(() => undefined);

/**
 * The row after one more failure (8.6): the failure is appended for the backoff, and the latest one is always kept in
 * `error` (the TEST flow and the UI show phase and message). `markInstallation` is true when repeated failures mean
 * the installation itself should be marked errored. Pure.
 */
export const failureRecord = (
  record: InstanceRecord,
  phase: string,
  error: unknown,
  stderrTail: string[],
  now: number,
): { updated: InstanceRecord; message: string; markInstallation: boolean } => {
  const failures = [...recordFailure(record.failures, now)];
  const message = error instanceof Error ? error.message : String(error);
  return {
    updated: { ...record, failures, error: { phase, message, stderrTail, at: now } },
    message,
    markInstallation: isInstallationError(failures, now),
  };
};

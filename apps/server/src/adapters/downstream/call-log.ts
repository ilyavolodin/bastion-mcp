import type { CallLogPort } from '@bastion-mcp/mcp-downstream';
import { type CallLogRow, CallLogWriter } from '@bastion-mcp/telemetry';
import type { Infra } from '../../infra';
import type { SettingsCache } from '../config-watch';

/**
 * `CallLogPort` (15.5): the telemetry `CallLogWriter` (500 ms / 500 rows batches, bounded buffer) over the db
 * `insertBatch` sink; dropped rows are counted on `bastion.calllog.dropped`; previews are captured only while
 * `settings.logs.capturePreviews` is on. Rows of `/mcp/c/*` requests carry `origin: 'plugin'` set by mcp-downstream
 * and stored by the repository (migration 0003 adds the column).
 */
export const createCallLog = (
  infra: Infra,
  settings: Pick<SettingsCache, 'get'>,
): CallLogPort & { flush(): Promise<void>; close(): Promise<void> } => {
  const writer = new CallLogWriter({
    sink: (rows) => infra.repos.callLog.insertBatch(rows as never),
    onDropped: (count) => infra.metrics.calllogDropped.add(count),
    capturePreviews: () => settings.get().logs.capturePreviews,
    onSinkError: (error, retryInMs) =>
      infra.logger.warn({ err: String(error), retryInMs }, 'call log write failed; retrying'),
  });
  return {
    append: (row: CallLogRow) => writer.append(row),
    flush: () => writer.flush(),
    close: () => writer.close(),
  };
};

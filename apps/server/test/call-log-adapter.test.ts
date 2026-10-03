import type { CallLogRow } from '@bastion-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { createCallLog } from '../src/adapters/downstream/call-log';
import { fakeInfra, recordingLogger } from './fake-infra';

const row = (over: Partial<CallLogRow> = {}): CallLogRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  ts: new Date('2026-03-01T00:00:00Z'),
  durationMs: 12,
  principalType: 'user',
  principalId: '22222222-2222-4222-8222-222222222222',
  method: 'tools/call',
  outcome: 'ok',
  eraDown: 'modern',
  coldStart: false,
  bytesIn: 1,
  bytesOut: 2,
  argsPreview: { query: 'x', token: 'secret-value' },
  ...over,
});

const harness = (capturePreviews: boolean) => {
  const written: CallLogRow[][] = [];
  const dropped: number[] = [];
  const infra = fakeInfra({
    logger: recordingLogger(),
    repos: {
      callLog: {
        insertBatch: async (rows: CallLogRow[]) => {
          written.push(rows);
        },
      },
    },
    metrics: { calllogDropped: { add: (n: number) => dropped.push(n) } },
  });
  const log = createCallLog(infra, { get: () => ({ logs: { capturePreviews } }) as never });
  return { log, written, dropped };
};

describe('15.5 call log adapter', () => {
  it('writes buffered rows to the repository sink on flush', async () => {
    const h = harness(false);
    h.log.append(row());
    h.log.append(row({ id: '33333333-3333-4333-8333-333333333333' }));
    await h.log.flush();
    expect(h.written.flat().map((r) => r.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
    ]);
    await h.log.close();
  });

  it('drops previews unless the org captures them', async () => {
    const off = harness(false);
    off.log.append(row());
    await off.log.flush();
    expect(off.written[0]?.[0]?.argsPreview).toBeUndefined();
    await off.log.close();
  });

  it('redacts secrets in captured previews', async () => {
    const on = harness(true);
    on.log.append(row());
    await on.log.flush();
    expect(on.written[0]?.[0]?.argsPreview).toEqual({ query: 'x', token: '[REDACTED]' });
    await on.log.close();
  });

  it('counts rows appended after close as dropped', async () => {
    const h = harness(false);
    await h.log.close();
    h.log.append(row());
    expect(h.dropped).toEqual([1]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreviewPolicy,
  buildPreview,
  type CallLogRow,
  CallLogWriter,
  MAX_PREVIEW_BYTES,
  parseCallLogRow,
  redactValue,
  safeParseCallLogRow,
} from '../src';

let n = 0;
const row = (over: Partial<CallLogRow> = {}): CallLogRow =>
  parseCallLogRow({
    id: '22222222-2222-4222-8222-222222222222',
    ts: new Date('2026-05-01T10:00:00Z'),
    durationMs: ++n,
    principalType: 'user',
    principalId: '33333333-3333-4333-8333-333333333333',
    method: 'tools/call',
    outcome: 'ok',
    eraDown: 'modern',
    ...over,
  });

beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('16.2 CallLogRow', () => {
  it('16.2 applies column defaults and validates closed sets', () => {
    const r = row();
    expect(r).toMatchObject({ coldStart: false, bytesIn: 0, bytesOut: 0 });
    expect(safeParseCallLogRow({ ...r, outcome: 'weird' }).success).toBe(false);
    expect(safeParseCallLogRow({ ...r, principalId: 'nope' }).success).toBe(false);
    expect(safeParseCallLogRow({ ...r, durationMs: -1 }).success).toBe(false);
  });
});

describe('15.5 previews', () => {
  it('15.5 redacts secrets by key at any depth', () => {
    expect(
      redactValue({
        a: 1,
        authorization: 'x',
        nested: [{ password: 'p', ok: true }],
        accessToken: 't',
      }),
    ).toEqual({
      a: 1,
      authorization: '[REDACTED]',
      nested: [{ password: '[REDACTED]', ok: true }],
      accessToken: '[REDACTED]',
    });
    expect(redactValue(deep(12))).toBeDefined();
  });

  it('15.5 caps each preview at 2 KiB', () => {
    const big = buildPreview({ text: 'x'.repeat(10_000) }) as {
      truncated: boolean;
      preview: string;
    };
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(buildPreview({ small: 1 })).toEqual({ small: 1 });
    expect(buildPreview(undefined)).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(buildPreview(circular)).toBeDefined();
    expect(buildPreview(undefined)).toBeUndefined();
  });

  it('15.5 stores previews only when capturePreviews is on', () => {
    const r = row({ argsPreview: { token: 's', q: 1 }, resultPreview: { r: 1 } });
    const off = applyPreviewPolicy(r, false);
    expect('argsPreview' in off).toBe(false);
    expect('resultPreview' in off).toBe(false);
    const on = applyPreviewPolicy(r, true);
    expect(on.argsPreview).toEqual({ token: '[REDACTED]', q: 1 });
    expect(on.resultPreview).toEqual({ r: 1 });
    expect(applyPreviewPolicy(row(), true)).not.toHaveProperty('argsPreview');
  });
});

const deep = (d: number): unknown => (d === 0 ? 'leaf' : { next: deep(d - 1) });

describe('15.5 CallLogWriter', () => {
  const make = (over: Partial<ConstructorParameters<typeof CallLogWriter>[0]> = {}) => {
    const batches: CallLogRow[][] = [];
    const dropped = vi.fn();
    const sink = vi.fn(async (rows: CallLogRow[]) => {
      batches.push(rows);
    });
    const writer = new CallLogWriter({ sink, onDropped: dropped, ...over });
    return { writer, batches, dropped, sink };
  };

  it('15.5 flushes buffered rows 500 ms after the first append', async () => {
    const { writer, batches } = make();
    writer.append(row());
    writer.append(row());
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(writer.size).toBe(0);
  });

  it('15.5 flushes immediately at 500 rows without waiting for the timer', async () => {
    const { writer, batches } = make();
    for (let i = 0; i < 500; i++) writer.append(row());
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.map((b) => b.length)).toEqual([500]);
  });

  it('15.5 splits a larger backlog into batches of at most 500 rows', async () => {
    const { writer, batches } = make();
    for (let i = 0; i < 1200; i++) writer.append(row());
    await writer.flush();
    expect(batches.map((b) => b.length)).toEqual([500, 500, 200]);
  });

  it('15.5 drops the oldest rows when the 50,000-row buffer is full', async () => {
    const { writer, batches, dropped } = make({ sink: () => new Promise(() => {}) });
    const first = row({ durationMs: 1 });
    // The first batch of 500 is stuck in the sink; keep appending behind it.
    for (let i = 0; i < 500; i++) writer.append(i === 0 ? first : row());
    expect(batches).toHaveLength(0);
    // sink never resolves: buffer is now empty (batch is in flight); fill it past the cap.
    for (let i = 0; i < 50_003; i++) writer.append(row({ durationMs: 1000 + i }));
    expect(writer.size).toBe(50_000);
    expect(dropped).toHaveBeenCalledTimes(3);
    expect(dropped.mock.calls.every(([c]) => c === 1)).toBe(true);
  });

  it('15.5 keeps the newest rows and counts the dropped ones through the callback', async () => {
    const seen: number[] = [];
    const { writer, dropped } = make({
      maxBuffered: 3,
      batchSize: 100,
      sink: async (rows) => {
        seen.push(...rows.map((r) => r.durationMs));
      },
    });
    for (let i = 1; i <= 5; i++) writer.append(row({ durationMs: i }));
    await writer.flush();
    expect(seen).toEqual([3, 4, 5]);
    expect(dropped).toHaveBeenCalledTimes(2);
  });

  it('15.5 keeps rows after a failed sink and retries with backoff', async () => {
    let fail = 2;
    const delivered: number[] = [];
    const errors: number[] = [];
    const { writer } = make({
      sink: async (rows) => {
        if (fail-- > 0) throw new Error('db down');
        delivered.push(rows.length);
      },
      onSinkError: (_e, retryInMs) => errors.push(retryInMs),
    });
    writer.append(row());
    writer.append(row());
    await vi.advanceTimersByTimeAsync(500); // 1st attempt fails
    expect(writer.size).toBe(2);
    expect(errors).toEqual([500]);
    await vi.advanceTimersByTimeAsync(499);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // retry after 500 ms fails again
    expect(errors).toEqual([500, 1000]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toEqual([2]);
    expect(writer.size).toBe(0);
  });

  it('15.5 caps backoff and bounds retained rows by the same 50,000 cap on failure', async () => {
    const errors: number[] = [];
    const { writer, dropped } = make({
      maxBuffered: 10,
      batchSize: 5,
      backoffMaxMs: 1500,
      sink: async () => {
        throw new Error('down');
      },
      onSinkError: (_e, ms) => errors.push(ms),
    });
    for (let i = 0; i < 5; i++) writer.append(row());
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) writer.append(row());
    expect(writer.size).toBeLessThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Math.max(...errors)).toBe(1500);
    expect(writer.size).toBeLessThanOrEqual(10);
    expect(dropped).toHaveBeenCalled();
  });

  it('15.5 close() drains the buffer on shutdown and ignores later rows', async () => {
    const { writer, batches, dropped } = make();
    writer.append(row());
    await writer.close();
    expect(batches).toHaveLength(1);
    writer.append(row());
    expect(dropped).toHaveBeenCalledWith(1);
    expect(writer.size).toBe(0);
  });

  it('15.5 close() counts rows the sink still refuses as dropped', async () => {
    const { writer, dropped } = make({
      sink: async () => {
        throw new Error('down');
      },
    });
    writer.append(row());
    writer.append(row());
    await writer.close();
    expect(dropped).toHaveBeenCalledWith(2);
    expect(writer.size).toBe(0);
  });

  it('15.5 serializes concurrent flush calls', async () => {
    let active = 0;
    let maxActive = 0;
    const { writer } = make({
      sink: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
    });
    writer.append(row());
    const a = writer.flush();
    writer.append(row());
    const b = writer.flush();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([a, b]);
    expect(maxActive).toBe(1);
    expect(writer.size).toBe(0);
  });

  it('15.5 honours the capturePreviews option, including as a live function', async () => {
    let capture = false;
    const { writer, batches } = make({ capturePreviews: () => capture });
    writer.append(row({ argsPreview: { a: 1 } }));
    capture = true;
    writer.append(row({ argsPreview: { a: 1 } }));
    await writer.flush();
    expect(batches[0]?.[0]).not.toHaveProperty('argsPreview');
    expect(batches[0]?.[1]?.argsPreview).toEqual({ a: 1 });
    const on = make({ capturePreviews: true });
    on.writer.append(row({ argsPreview: { b: 2 } }));
    await on.writer.flush();
    expect(on.batches[0]?.[0]?.argsPreview).toEqual({ b: 2 });
  });
});

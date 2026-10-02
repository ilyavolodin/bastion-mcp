import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, initialize, startHarness } from './legacy-harness';

let h: Harness;
let sessionId: string;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled);
  h = await startHarness();
  sessionId = await initialize(h);
});
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await h.close();
});

const headerValue = fc.oneof(
  fc.constant(undefined),
  fc.string({ maxLength: 40 }).map((s) => s.replace(/[^\x21-\x7e]/g, '')),
  fc.constantFrom('2025-11-25', '2025-06-18', '2026-07-28', 'x'),
);

describe('23.3 fuzzing the legacy adapter', () => {
  it('23.3 arbitrary JSON bodies and headers never crash the adapter and always get an HTTP answer', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.json().map((s) => s),
          fc.string({ maxLength: 60 }).map((s) => JSON.stringify(s)),
        ),
        fc.oneof(fc.constant(sessionId), headerValue),
        headerValue,
        fc.boolean(),
        async (bodyJson, session, version, wantSse) => {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: wantSse ? 'text/event-stream' : 'application/json',
          };
          if (session !== undefined) headers['mcp-session-id'] = session;
          if (version !== undefined) headers['mcp-protocol-version'] = version;
          const res = await fetch(h.url, { method: 'POST', headers, body: bodyJson });
          await res.text();
          expect(res.status).toBeLessThan(500);
        },
      ),
      { numRuns: 120 },
    );
    expect(unhandled).toEqual([]);
  }, 30_000);

  it('23.3 structured JSON-RPC-looking messages with arbitrary params never crash either', async () => {
    const message = fc.record(
      {
        jsonrpc: fc.constantFrom('2.0', '1.0'),
        id: fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.constant(null)),
        method: fc.constantFrom(
          'tools/call',
          'tools/list',
          'ping',
          'initialize',
          'notifications/cancelled',
          'logging/setLevel',
          'resources/subscribe',
          'x/y',
        ),
        params: fc.oneof(fc.jsonValue(), fc.constant(undefined)),
        result: fc.jsonValue(),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(message, async (msg) => {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'mcp-session-id': sessionId,
          },
          body: JSON.stringify(msg),
        });
        await res.text();
        expect(res.status).toBeLessThan(500);
      }),
      { numRuns: 120 },
    );
    expect(unhandled).toEqual([]);
  }, 30_000);
});

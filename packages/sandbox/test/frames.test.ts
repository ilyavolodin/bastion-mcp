import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  exitFrame,
  MAX_STDERR_LINE_BYTES,
  messageFrame,
  stderrFrame,
  truncateUtf8,
} from '../src/protocol';

describe('8.3 stdio frames', () => {
  it('8.3 encodes a message frame as {"t":"m","d":msg}', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect(JSON.parse(messageFrame(msg))).toEqual({ t: 'm', d: msg });
  });

  it('8.3 encodes exit frames with null code or signal', () => {
    expect(JSON.parse(exitFrame(null, 'SIGKILL'))).toEqual({
      t: 'x',
      code: null,
      signal: 'SIGKILL',
    });
    expect(JSON.parse(exitFrame(3, null))).toEqual({ t: 'x', code: 3, signal: null });
  });

  it('8.3 truncates stderr lines to 8 KiB', () => {
    const frame = JSON.parse(stderrFrame('a'.repeat(20_000))) as { d: string };
    expect(frame.d.length).toBe(MAX_STDERR_LINE_BYTES);
  });

  it('8.3 truncation never splits a multibyte character', () => {
    const text = '€'.repeat(5000);
    const out = truncateUtf8(text, MAX_STDERR_LINE_BYTES);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_STDERR_LINE_BYTES);
    expect(out).toMatch(/^€+$/);
    expect(truncateUtf8('😀😀', 5)).toBe('😀');
    expect(truncateUtf8('abc', 0)).toBe('');
  });

  it('8.3 a worker may only send message frames', () => {
    expect(decodeFrame('{"t":"e","d":"x"}', 'toRunner').ok).toBe(false);
    expect(decodeFrame('{"t":"x","code":0,"signal":null}', 'toRunner').ok).toBe(false);
    expect(decodeFrame('{"t":"m","d":{"jsonrpc":"2.0","id":1,"method":"x"}}', 'toRunner').ok).toBe(
      true,
    );
  });

  it.each([
    'not json',
    '[]',
    '{"t":"q"}',
    '{"t":"m","d":{"id":1}}',
    '{"t":"m","d":[]}',
    '{"t":"e","d":5}',
    '{"t":"x","code":"1","signal":null}',
    '{"t":"x","code":1.5,"signal":null}',
    '{"t":"x","code":1,"signal":3}',
  ])('8.3 rejects malformed frame %s', (raw) => {
    expect(decodeFrame(raw).ok).toBe(false);
  });

  it('8.3 decodes binary payloads and bounds the frame size', () => {
    const buf = Buffer.from('{"t":"e","d":"hi"}');
    expect(decodeFrame(buf)).toEqual({ ok: true, frame: { t: 'e', d: 'hi' } });
    expect(decodeFrame('x'.repeat(34 * 1024 * 1024)).ok).toBe(false);
  });

  it('8.3 property: encode then decode round-trips every frame', () => {
    const json = fc.dictionary(fc.string(), fc.jsonValue()).map((o) => ({ ...o, jsonrpc: '2.0' }));
    const frame = fc.oneof(
      json.map((d) => ({ t: 'm' as const, d })),
      fc.string({ maxLength: 500 }).map((d) => ({ t: 'e' as const, d })),
      fc.record({
        t: fc.constant('x' as const),
        code: fc.option(fc.integer(), { nil: null }),
        signal: fc.option(fc.string(), { nil: null }),
      }),
    );
    fc.assert(
      fc.property(frame, (f) => {
        const decoded = decodeFrame(encodeFrame(f));
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(decoded.frame).toEqual(JSON.parse(JSON.stringify(f)));
      }),
      { numRuns: 200 },
    );
  });

  it('23.3 fuzz: the decoder never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.uint8Array(), fc.json()), (raw) => {
        const result = decodeFrame(raw);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

import { decodeFrame, encodeFrame } from '@bastion-mcp/sandbox/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyStdoutLine, LineSplitter } from '../src/lines';

// 23.3: the runner frame parser is fuzzed for 10 minutes nightly (FUZZ_RUNS raises the count; unit runs stay short).
const runs = Number(process.env.FUZZ_RUNS ?? 200);

describe('23.3 runner frame parser fuzzing', () => {
  it('23.3 arbitrary text and bytes never throw and accepted frames re-encode', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.uint8Array(),
          fc.json(),
          fc.string().map((s) => `{"t":"m","d":${s}}`),
        ),
        (raw) => {
          const r = decodeFrame(raw, 'toRunner');
          if (r.ok) expect(decodeFrame(encodeFrame(r.frame), 'toRunner').ok).toBe(true);
        },
      ),
      { numRuns: runs },
    );
  });
  it('23.3 arbitrary stdout chunks never break the splitter and classifier', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 20 }), (chunks) => {
        const s = new LineSplitter(256);
        for (const c of chunks) for (const l of s.push(Buffer.from(c))) classifyStdoutLine(l);
        s.flush();
      }),
      { numRuns: runs },
    );
  });
});

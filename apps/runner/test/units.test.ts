import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';
import { verifyBearer } from '../src/auth';
import { MAX_BUFFERED_BYTES, MAX_BUFFERED_MESSAGES, OutputBuffer } from '../src/buffer';
import { classifyStdoutLine, LineSplitter } from '../src/lines';
import { decideRequest, type RunnerState, requiredState, transition } from '../src/state';

describe('8.3 runner state machine', () => {
  it('8.3 bind is accepted exactly once', () => {
    expect(transition('unbound', 'bind')).toEqual({ ok: true, state: 'bound' });
    expect(transition('bound', 'bind').ok).toBe(false);
    expect(transition('running', 'bind').ok).toBe(false);
  });

  it('8.3 start needs bound; stopped returns to bound', () => {
    expect(transition('bound', 'start')).toEqual({ ok: true, state: 'running' });
    expect(transition('unbound', 'start').ok).toBe(false);
    expect(transition('running', 'start').ok).toBe(false);
    expect(transition('running', 'stopped')).toEqual({ ok: true, state: 'bound' });
    expect(transition('bound', 'stopped').ok).toBe(false);
  });

  it('8.3 each endpoint requires the documented state', () => {
    expect(requiredState({ method: 'GET', path: '/healthz' })).toBe('any');
    expect(requiredState({ method: 'POST', path: '/v1/bind' })).toBe('unbound');
    expect(requiredState({ method: 'POST', path: '/v1/start' })).toBe('bound');
    expect(requiredState({ method: 'GET', path: '/v1/stdio' })).toBe('running');
    expect(requiredState({ method: 'POST', path: '/v1/stop' })).toBe('running');
    expect(requiredState({ method: 'GET', path: '/nope' })).toBeNull();
  });

  it('8.3 after bind every request but /healthz needs the token', () => {
    const ep = { method: 'POST', path: '/v1/start' };
    expect(decideRequest('bound', ep, false)).toMatchObject({ allow: false, status: 401 });
    expect(decideRequest('bound', ep, true)).toEqual({ allow: true });
    expect(decideRequest('bound', { method: 'GET', path: '/healthz' }, false)).toEqual({
      allow: true,
    });
    expect(decideRequest('bound', { method: 'POST', path: '/v1/bind' }, true)).toMatchObject({
      allow: false,
      status: 409,
    });
    expect(decideRequest('unbound', { method: 'POST', path: '/v1/bind' }, false)).toEqual({
      allow: true,
    });
    expect(decideRequest('unbound', ep, false)).toMatchObject({ allow: false, status: 409 });
    expect(decideRequest('bound', { method: 'GET', path: '/v1/stdio' }, true)).toMatchObject({
      allow: false,
      status: 409,
    });
    expect(decideRequest('running', { method: 'GET', path: '/x' }, true)).toMatchObject({
      status: 404,
    });
  });

  it('8.3 property: bind is never accepted twice, whatever the event order', () => {
    const events = fc.array(fc.constantFrom('bind', 'start', 'stopped'), { maxLength: 30 });
    fc.assert(
      fc.property(events, (list) => {
        let state: RunnerState = 'unbound';
        let binds = 0;
        for (const e of list) {
          const r = transition(state, e);
          if (r.ok) {
            state = r.state;
            if (e === 'bind') binds += 1;
          }
        }
        expect(binds).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('8.3 bearer verification', () => {
  it('8.3 accepts only the exact bound token (constant-time compare)', () => {
    expect(verifyBearer('Bearer secret-token-123', 'secret-token-123')).toBe(true);
    expect(verifyBearer('Bearer secret-token-124', 'secret-token-123')).toBe(false);
    expect(verifyBearer('Bearer short', 'secret-token-123')).toBe(false);
    expect(verifyBearer('secret-token-123', 'secret-token-123')).toBe(false);
    expect(verifyBearer(undefined, 'secret-token-123')).toBe(false);
    expect(verifyBearer('Bearer x', undefined)).toBe(false);
    expect(verifyBearer('Bearer ', '')).toBe(false);
  });

  it('8.3 property: matches iff equal', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        expect(verifyBearer(`Bearer ${a}`, b)).toBe(a === b);
      }),
    );
  });
});

describe('8.3 output buffer', () => {
  it('8.3 keeps at most 1,000 messages and counts dropped ones, oldest first', () => {
    const buf = new OutputBuffer();
    for (let i = 0; i < MAX_BUFFERED_MESSAGES + 5; i += 1) buf.push(`m${i}`);
    expect(buf.size).toBe(MAX_BUFFERED_MESSAGES);
    expect(buf.dropped).toBe(5);
    const drained = buf.drain();
    expect(drained.dropped).toBe(5);
    expect(drained.frames[0]).toBe('m5');
    expect(buf.size).toBe(0);
    expect(buf.dropped).toBe(0);
  });

  it('8.3 keeps at most 4 MiB, dropping the oldest', () => {
    const buf = new OutputBuffer();
    const chunk = 'x'.repeat(1024 * 1024 - 10);
    for (let i = 0; i < 6; i += 1) buf.push(chunk + i);
    expect(buf.byteSize).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    expect(buf.dropped).toBe(2);
    expect(buf.drain().frames[0]?.endsWith('2')).toBe(true);
  });

  it('8.3 a single frame larger than the buffer is dropped, not stored', () => {
    const buf = new OutputBuffer(10, 100);
    buf.push('y'.repeat(200));
    expect(buf.size).toBe(0);
    expect(buf.dropped).toBe(1);
  });

  it('8.3 property: limits hold and kept + dropped equals pushed', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 200 }), (frames) => {
        const buf = new OutputBuffer(10, 200);
        for (const f of frames) buf.push(f);
        expect(buf.size).toBeLessThanOrEqual(10);
        expect(buf.byteSize).toBeLessThanOrEqual(200);
        expect(buf.size + buf.dropped).toBe(frames.length);
      }),
    );
  });
});

describe('8.3 stdout line splitting', () => {
  it('8.3 splits on newline across chunks and multibyte boundaries', () => {
    const s = new LineSplitter();
    const bytes = Buffer.from('{"a":"€"}\nsecond\r\npart');
    const out = [...s.push(bytes.subarray(0, 7)), ...s.push(bytes.subarray(7))];
    expect(out).toEqual(['{"a":"€"}', 'second']);
    expect(s.flush()).toBe('part');
    expect(s.flush()).toBeUndefined();
  });

  it('8.3 a never-terminated over-long line is cut once and its remainder discarded', () => {
    const s = new LineSplitter(100);
    const first = s.push('a'.repeat(150));
    expect(first).toHaveLength(1);
    expect(s.push('b'.repeat(10))).toEqual([]);
    expect(s.push('\nok\n')).toEqual(['ok']);
  });

  it('8.3 property: chunking does not change the lines', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ maxLength: 20 }).filter((l) => !l.includes('\n') && !l.includes('\r')),
        ),
        fc.integer({ min: 1, max: 7 }),
        (lines, size) => {
          const input = Buffer.from(lines.map((l) => `${l}\n`).join(''));
          const s = new LineSplitter();
          const out: string[] = [];
          for (let i = 0; i < input.length; i += size) {
            out.push(...s.push(input.subarray(i, i + size)));
          }
          expect(out).toEqual(lines);
        },
      ),
    );
  });

  it('8.3 JSON-RPC lines are messages, everything else is stderr', () => {
    expect(classifyStdoutLine('{"jsonrpc":"2.0","id":1,"result":{}}').kind).toBe('message');
    expect(classifyStdoutLine('hello').kind).toBe('stderr');
    expect(classifyStdoutLine('{"foo":1}').kind).toBe('stderr');
    expect(classifyStdoutLine('[{"jsonrpc":"2.0"}]').kind).toBe('stderr');
    expect(classifyStdoutLine('   ').kind).toBe('blank');
  });

  it('23.3 fuzz: classification never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (line) => {
        expect(['message', 'stderr', 'blank']).toContain(classifyStdoutLine(line).kind);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

describe('8.3 command line', () => {
  it('8.3 defaults to 0.0.0.0:8080', () => {
    expect(parseArgs([])).toEqual({
      listen: { kind: 'tcp', host: '0.0.0.0', port: 8080 },
      egress: undefined,
    });
  });
  it('8.5 parses unix listen and egress sockets', () => {
    expect(
      parseArgs([
        '--listen',
        'unix:/run/bastion/runner.sock',
        '--egress',
        'unix:/run/bastion/egress.sock',
      ]),
    ).toEqual({
      listen: { kind: 'unix', path: '/run/bastion/runner.sock' },
      egress: { socketPath: '/run/bastion/egress.sock' },
    });
    expect(parseArgs(['--listen', '127.0.0.1:9000']).listen).toEqual({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 9000,
    });
  });
  it('rejects bad arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
    expect(() => parseArgs(['--listen'])).toThrow();
    expect(() => parseArgs(['--listen', 'nope'])).toThrow();
    expect(() => parseArgs(['--egress', '1.2.3.4:5'])).toThrow();
  });
});

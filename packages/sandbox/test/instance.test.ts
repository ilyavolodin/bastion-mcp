import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  crashCountsAsFailure,
  type InstanceEvent,
  type InstanceState,
  type InstanceSummary,
  instanceStateMachine,
  isInstallationError,
  pickLruIdleInstance,
  recordFailure,
  retryDecision,
  START_PHASES_ORDER,
} from '../src/instance-state';
import { StderrPipeline, StderrRateLimiter, StderrTail } from '../src/stderr';

const apply = (state: InstanceState, ...events: InstanceEvent[]): InstanceState => {
  let s = state;
  for (const e of events) {
    const r = instanceStateMachine(s, e);
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
  }
  return s;
};

describe('8.6 instance state machine', () => {
  it('8.6 walks absent -> starting phases -> ready -> idle -> stopping -> absent', () => {
    let s: InstanceState = { kind: 'absent' };
    s = apply(s, { type: 'start' });
    expect(s).toEqual({ kind: 'starting', phase: 'claiming' });
    for (const phase of START_PHASES_ORDER.slice(1)) s = apply(s, { type: 'phase', phase });
    s = apply(s, { type: 'connected' });
    expect(s.kind).toBe('ready');
    s = apply(s, { type: 'idleTimeout' });
    expect(s.kind).toBe('idle');
    s = apply(s, { type: 'activity' });
    expect(s.kind).toBe('ready');
    s = apply(s, { type: 'stop' }, { type: 'stopped' });
    expect(s).toEqual({ kind: 'absent' });
  });
  it('8.6 failed start goes through failed to absent; a crash drops to absent', () => {
    expect(
      apply(
        { kind: 'absent' },
        { type: 'start' },
        { type: 'phase', phase: 'installing' },
        { type: 'fail' },
      ),
    ).toEqual({
      kind: 'failed',
      phase: 'installing',
    });
    expect(apply({ kind: 'failed', phase: 'binding' }, { type: 'reset' })).toEqual({
      kind: 'absent',
    });
    expect(apply({ kind: 'ready' }, { type: 'crashed' })).toEqual({ kind: 'absent' });
  });
  it('8.6 rejects invalid transitions', () => {
    expect(instanceStateMachine({ kind: 'ready' }, { type: 'start' }).ok).toBe(false);
    expect(
      instanceStateMachine(
        { kind: 'starting', phase: 'installing' },
        { type: 'phase', phase: 'binding' },
      ).ok,
    ).toBe(false);
    expect(
      instanceStateMachine({ kind: 'starting', phase: 'installing' }, { type: 'connected' }).ok,
    ).toBe(false);
    expect(instanceStateMachine({ kind: 'absent' }, { type: 'idleTimeout' }).ok).toBe(false);
    expect(instanceStateMachine({ kind: 'absent' }, { type: 'stop' }).ok).toBe(false);
    expect(instanceStateMachine({ kind: 'ready' }, { type: 'stopped' }).ok).toBe(false);
    expect(instanceStateMachine({ kind: 'ready' }, { type: 'fail' }).ok).toBe(false);
    expect(
      instanceStateMachine({ kind: 'starting', phase: 'claiming' }, { type: 'crashed' }).ok,
    ).toBe(false);
    expect(instanceStateMachine({ kind: 'ready' }, { type: 'reset' }).ok).toBe(false);
    expect(instanceStateMachine({ kind: 'absent' }, { type: 'activity' }).ok).toBe(false);
    expect(instanceStateMachine({ kind: 'absent' }, { type: 'phase', phase: 'binding' }).ok).toBe(
      false,
    );
  });
  it('8.6 property: the machine never leaves the known state set', () => {
    const events: fc.Arbitrary<InstanceEvent> = fc.oneof(
      fc.constantFrom<InstanceEvent>(
        { type: 'start' },
        { type: 'connected' },
        { type: 'idleTimeout' },
        { type: 'activity' },
        { type: 'stop' },
        { type: 'stopped' },
        { type: 'fail' },
        { type: 'crashed' },
        { type: 'reset' },
      ),
      fc
        .constantFrom(...START_PHASES_ORDER)
        .map((phase): InstanceEvent => ({ type: 'phase', phase })),
    );
    fc.assert(
      fc.property(fc.array(events, { maxLength: 40 }), (list) => {
        let s: InstanceState = { kind: 'absent' };
        for (const e of list) {
          const r = instanceStateMachine(s, e);
          if (r.ok) s = r.state;
        }
        expect(['absent', 'starting', 'ready', 'idle', 'stopping', 'failed']).toContain(s.kind);
      }),
    );
  });
});

describe('8.6 failure backoff', () => {
  it('8.6 backoff is 5 s, 30 s, 2 min, then 10 min', () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([5000, 30000, 120000, 600000, 600000]);
    expect(backoffMs(0)).toBe(0);
  });
  it('8.6 retry is refused until the backoff passes', () => {
    const h = recordFailure([], 1000);
    expect(retryDecision(h, 3000)).toEqual({ allowed: false, retryInMs: 3000 });
    expect(retryDecision(h, 6000)).toEqual({ allowed: true });
    expect(retryDecision([], 0)).toEqual({ allowed: true });
  });
  it('8.6 three failures within 30 minutes mark the installation error', () => {
    let h = recordFailure([], 0);
    h = recordFailure(h, 60_000);
    expect(isInstallationError(h, 61_000)).toBe(false);
    h = recordFailure(h, 120_000);
    expect(isInstallationError(h, 121_000)).toBe(true);
    expect(retryDecision(h, 121_000)).toMatchObject({ allowed: false });
    expect(isInstallationError(h, 31 * 60_000 + 120_000)).toBe(false);
  });
  it('8.6 failures older than 30 minutes are pruned and reset the backoff', () => {
    const h = recordFailure(recordFailure([], 0), 40 * 60_000);
    expect(h).toEqual([40 * 60_000]);
  });
  it('8.6 a crash within 30 s of start counts as a failure', () => {
    expect(crashCountsAsFailure(0, 29_999)).toBe(true);
    expect(crashCountsAsFailure(0, 30_000)).toBe(false);
  });
});

describe('8.6 LRU eviction', () => {
  const mk = (id: string, over: Partial<InstanceSummary>): InstanceSummary => ({
    id,
    userId: 'u1',
    state: 'idle',
    lastUsedAt: 100,
    inflight: 0,
    ...over,
  });
  it('8.6 picks the least recently used idle-eligible instance of that user', () => {
    const list = [
      mk('a', { lastUsedAt: 300 }),
      mk('b', { lastUsedAt: 100, inflight: 1 }),
      mk('c', { lastUsedAt: 200, state: 'ready' }),
      mk('d', { lastUsedAt: 50, userId: 'u2' }),
      mk('e', { lastUsedAt: 10, state: 'starting' }),
    ];
    expect(pickLruIdleInstance(list, 'u1')?.id).toBe('c');
  });
  it('8.6 returns undefined when nothing can be evicted', () => {
    expect(pickLruIdleInstance([mk('b', { inflight: 2 })], 'u1')).toBeUndefined();
    expect(pickLruIdleInstance([], 'u1')).toBeUndefined();
  });
});

describe('8.7 stderr handling', () => {
  it('8.7 rate-limits to 200 lines/s and refills over time', () => {
    let now = 0;
    const limiter = new StderrRateLimiter(200, { now: () => now });
    let emitted = 0;
    for (let i = 0; i < 500; i += 1) if (limiter.take().emit) emitted += 1;
    expect(emitted).toBe(200);
    now = 1000;
    const next = limiter.take();
    expect(next).toEqual({ emit: true, suppressedBefore: 300 });
  });
  it('8.7 keeps the last 1,000 lines', () => {
    const tail = new StderrTail();
    for (let i = 0; i < 1200; i += 1) tail.push(`l${i}`);
    expect(tail.size).toBe(1000);
    expect(tail.tail(2)).toEqual(['l1198', 'l1199']);
    expect(tail.tail()[0]).toBe('l200');
    expect(tail.tail(0)).toEqual([]);
  });
  it('8.7 the pipeline logs with instance attributes, feeds the sink and reports suppression', async () => {
    let now = 0;
    const sunk: string[] = [];
    const logged: { body: string; attributes: Record<string, unknown> }[] = [];
    const p = new StderrPipeline({
      instanceId: 'i1',
      installationId: 'inst1',
      clock: { now: () => now },
      sink: { write: (e) => void sunk.push(e.line) },
      logger: (r) => logged.push(r),
    });
    for (let i = 0; i < 205; i += 1) p.handle(`line ${i}`);
    expect(sunk).toHaveLength(200);
    expect(logged[0]).toMatchObject({
      name: 'bastion.sandbox.stderr',
      attributes: { 'bastion.instance.id': 'i1', 'bastion.installation.id': 'inst1' },
    });
    now = 5000;
    expect(p.handle('after')).toBe(true);
    expect(sunk.at(-2)).toMatch(/5 stderr lines suppressed/);
    expect(p.tail.size).toBe(202);
  });
  it('8.7 the pipeline works without sink or logger', () => {
    expect(new StderrPipeline({ instanceId: 'i', installationId: null }).handle('x')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  deterministicGuards,
  type EffectiveProfile,
  escalationFinding,
  GuardPipeline,
  oversizeOutcome,
  type PipelineInput,
} from '../src';
import { FakeClock, input, seg } from './helpers';

describe('13.3 oversizeOutcome', () => {
  const big = [seg('x'.repeat(100))];

  it('13.3 is undefined while the text fits', () => {
    expect(oversizeOutcome(big, { maxScanBytes: 100, onOversize: 'block' })).toBeUndefined();
  });

  it('13.3 blocks with a max-scan-bytes finding when configured to', () => {
    const out = oversizeOutcome(big, { maxScanBytes: 10, onOversize: 'block' });
    expect(out?.finding?.action).toBe('block');
    expect(out?.finding?.finding.ruleId).toBe('max-scan-bytes');
    expect(out?.segments).toBeUndefined();
  });

  it('13.3 scans a prefix and reports truncation otherwise', () => {
    const out = oversizeOutcome(big, { maxScanBytes: 10, onOversize: 'scanPrefix' });
    expect(out?.truncated).toBe(true);
    expect(out?.finding).toBeUndefined();
    expect(out?.segments?.[0]?.text.length).toBeLessThanOrEqual(10);
  });
});

describe('13.7 escalationFinding', () => {
  const esc: EffectiveProfile['riskEscalation'] = {
    enabled: true,
    threshold: 50,
    action: 'confirm',
  };
  const destructive: PipelineInput = {
    ...input('request', [seg('x')]),
    item: { kind: 'tool', name: 't', destructive: true },
  };

  it('13.7 escalates a destructive tool request at or above the threshold', () => {
    const f = escalationFinding(destructive, esc, 50);
    expect(f?.action).toBe('confirm');
    expect(f?.finding.reason).toContain('at or above 50');
  });

  it.each([
    ['below the threshold', destructive, esc, 49],
    ['disabled', destructive, { ...esc, enabled: false }, 99],
    ['a response', { ...destructive, phase: 'response' as const }, esc, 99],
    ['a harmless tool', input('request', [seg('x')]), esc, 99],
  ])('13.7 does not escalate %s', (_name, inp, e, score) => {
    expect(escalationFinding(inp, e, score)).toBeUndefined();
  });
});

describe('13.8 pipeline timer', () => {
  it('13.8 takes latency from the injected timer', async () => {
    let t = 0;
    const pipeline = new GuardPipeline({
      guards: deterministicGuards(),
      clock: new FakeClock(),
      timer: () => {
        t += 7;
        return t;
      },
    });
    const result = await pipeline.run(input('response', [seg('hello')]), {
      org: {
        profileId: 'p',
        guards: [{ instanceId: 'u', type: 'unicode', config: {} }],
      },
    });
    expect(result.records[0]?.latencyMs).toBe(7);
  });
});

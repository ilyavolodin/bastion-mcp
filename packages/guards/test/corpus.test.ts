import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGuardRegistry, GuardPipeline, ORG_DEFAULT_PROFILE } from '../src';
import { FakeClock, seg } from './helpers';

type Sample = { id: string; category?: string; text: string };
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./corpora/${name}.json`, import.meta.url), 'utf8')) as T;

const injection = load<Sample[]>('injection');
const benign = load<Sample[]>('benign');
const baseline = load<{
  detectionRate: number;
  maxFalsePositiveRate: number;
  injectionSamples: number;
}>('baseline');

const pipeline = new GuardPipeline({ guards: createGuardRegistry(), clock: new FakeClock() });
const flagged = async (text: string): Promise<boolean> => {
  const result = await pipeline.run(
    {
      phase: 'response',
      segments: [seg(text)],
      principal: { principalId: 'p' },
      installation: { installationId: 'i' },
      item: { kind: 'tool', name: 't' },
      method: 'tools/call',
    },
    { org: ORG_DEFAULT_PROFILE },
  );
  return result.action !== 'allow';
};

describe('guard corpora (23.3)', () => {
  it('23.3 the injection corpus is the size the baseline was recorded on', () => {
    expect(injection).toHaveLength(baseline.injectionSamples);
  });

  it('23.3 the default deterministic profile reaches the recorded baseline detection rate', async () => {
    const results = await Promise.all(injection.map((s) => flagged(s.text)));
    const rate = results.filter(Boolean).length / injection.length;
    expect(rate).toBeGreaterThanOrEqual(baseline.detectionRate);
  });

  it('23.3 every direct, role-marker, hidden-comment, exfiltration and unicode sample is detected', async () => {
    const direct = injection.filter(
      (s) =>
        s.category !== undefined &&
        !/^(paraphrase|encoded|other-language|split|social|tool-hijack)$/.test(s.category),
    );
    const missed: string[] = [];
    for (const s of direct) if (!(await flagged(s.text))) missed.push(s.id);
    expect(missed).toEqual([]);
  });

  it('23.3 the benign corpus of realistic tool outputs stays under a 1% false-positive rate', async () => {
    expect(benign.length).toBeGreaterThanOrEqual(100);
    const falsePositives: string[] = [];
    for (const s of benign) if (await flagged(s.text)) falsePositives.push(s.id);
    expect(falsePositives.length / benign.length).toBeLessThanOrEqual(
      baseline.maxFalsePositiveRate,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  checkAll,
  checkScenario,
  formatReport,
  fromSummary,
  type ResultFile,
  resultFileSchema,
} from '../src/results';
import { GiB, getScenario, SCENARIOS } from '../src/scenarios';
import { summarize } from '../src/stats';

const flat = (value: number, n = 20_000, errors = 0) =>
  fromSummary(summarize(Array<number>(n).fill(value), errors));

const callsResult = (
  viaMs: number,
  directMs: number,
  overrides: Partial<ResultFile> = {},
): ResultFile => ({
  schema: 1,
  scenario: 'call-guards-off',
  startedAt: '2026-10-02T00:00:00.000Z',
  durationSec: 300,
  offeredRate: 2000,
  achievedRate: 1999,
  series: { via: flat(viaMs), direct: flat(directMs) },
  config: {},
  ...overrides,
});

describe('23.4 scenario table', () => {
  it('has one scenario for each row of the performance targets', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      'call-guards-off',
      'call-guards-default',
      'list-30',
      'cold-start',
      'listen-streams',
      'forwarded-calls',
    ]);
  });

  it('encodes the thresholds of section 23.4', () => {
    const t = (id: Parameters<typeof getScenario>[0]) => getScenario(id).targets;
    expect(t('call-guards-off')).toContainEqual(
      expect.objectContaining({ kind: 'added', percentile: 'p50', maxMs: 5 }),
    );
    expect(t('call-guards-off')).toContainEqual(
      expect.objectContaining({ kind: 'added', percentile: 'p99', maxMs: 25 }),
    );
    expect(t('call-guards-default')).toContainEqual(
      expect.objectContaining({ kind: 'added', percentile: 'p99', maxMs: 30 }),
    );
    expect(t('list-30')).toContainEqual(
      expect.objectContaining({ kind: 'latency', percentile: 'p99', maxMs: 40 }),
    );
    expect(t('cold-start')).toContainEqual(
      expect.objectContaining({ kind: 'latency', percentile: 'p95', maxMs: 4000 }),
    );
    expect(t('listen-streams')).toContainEqual(
      expect.objectContaining({ kind: 'noStreamDrops', minStreams: 5000 }),
    );
    expect(t('listen-streams')).toContainEqual(
      expect.objectContaining({ kind: 'memory', maxBytes: 4 * GiB }),
    );
    expect(t('forwarded-calls')).toContainEqual(
      expect.objectContaining({ kind: 'delta', percentile: 'p99', maxMs: 10 }),
    );
    expect(getScenario('call-guards-off').defaults.rate).toBe(2000);
    expect(getScenario('listen-streams').defaults).toMatchObject({
      streams: 5000,
      durationSec: 3600,
    });
  });

  it('rejects an unknown scenario', () => {
    expect(() => getScenario('nope')).toThrow(/unknown scenario/);
  });
});

describe('23.4 results checker', () => {
  it('passes call-guards-off when added p50 < 5 ms and p99 < 25 ms', () => {
    const verdict = checkScenario(callsResult(6, 2));
    expect(verdict.passed).toBe(true);
  });

  it('fails when added p99 is 25 ms or more', () => {
    const verdict = checkScenario(callsResult(27, 2));
    expect(verdict.passed).toBe(false);
    expect(verdict.lines.find((l) => l.name.includes('added p99'))?.passed).toBe(false);
  });

  it('fails when added p50 is 5 ms or more even if p99 is fine', () => {
    const verdict = checkScenario(callsResult(8, 2));
    expect(verdict.lines.find((l) => l.name.includes('added p50'))?.passed).toBe(false);
  });

  it('applies the 30 ms budget with default guards', () => {
    const base = callsResult(33, 2, { scenario: 'call-guards-default' });
    expect(checkScenario(base).passed).toBe(false);
    expect(checkScenario(callsResult(20, 2, { scenario: 'call-guards-default' })).passed).toBe(
      true,
    );
  });

  it('fails when the direct baseline is missing instead of passing silently', () => {
    const r = callsResult(6, 2);
    const { direct: _ignored, ...series } = r.series;
    const verdict = checkScenario({ ...r, series });
    expect(verdict.passed).toBe(false);
    expect(verdict.lines.some((l) => l.name.includes('"direct" present') && !l.passed)).toBe(true);
  });

  it('fails when the generator could not sustain the offered rate', () => {
    expect(checkScenario(callsResult(6, 2, { achievedRate: 1500 })).passed).toBe(false);
  });

  it('fails runs that are too short to certify', () => {
    expect(checkScenario(callsResult(6, 2, { durationSec: 10 })).passed).toBe(false);
  });

  it('fails on a high error rate', () => {
    const r = callsResult(6, 2);
    expect(checkScenario({ ...r, series: { ...r.series, via: flat(6, 20_000, 100) } }).passed).toBe(
      false,
    );
  });

  it('checks tools/list p99 < 40 ms', () => {
    const r: ResultFile = {
      ...callsResult(39, 0),
      scenario: 'list-30',
      durationSec: 120,
      series: { via: flat(39, 5000) },
    };
    expect(checkScenario(r).passed).toBe(true);
    expect(checkScenario({ ...r, series: { via: flat(41, 5000) } }).passed).toBe(false);
  });

  it('checks cold start p95 < 4 s and zero failed starts', () => {
    const r: ResultFile = {
      schema: 1,
      scenario: 'cold-start',
      startedAt: 'x',
      durationSec: 100,
      series: { via: flat(3500, 40) },
      config: {},
    };
    expect(checkScenario(r).passed).toBe(true);
    expect(checkScenario({ ...r, series: { via: flat(4100, 40) } }).passed).toBe(false);
    expect(checkScenario({ ...r, series: { via: flat(3500, 40, 1) } }).passed).toBe(false);
  });

  it('checks 5,000 streams for an hour with no drops and memory under 4 GiB', () => {
    const ok: ResultFile = {
      schema: 1,
      scenario: 'listen-streams',
      startedAt: 'x',
      durationSec: 3600,
      series: {},
      streams: { opened: 5000, dropped: 0, failedToOpen: 0 },
      workerMemoryMaxBytes: 3.5 * GiB,
      config: {},
    };
    expect(checkScenario(ok).passed).toBe(true);
    expect(
      checkScenario({ ...ok, streams: { opened: 5000, dropped: 1, failedToOpen: 0 } }).passed,
    ).toBe(false);
    expect(
      checkScenario({ ...ok, streams: { opened: 4900, dropped: 0, failedToOpen: 100 } }).passed,
    ).toBe(false);
    expect(checkScenario({ ...ok, durationSec: 1800 }).passed).toBe(false);
    expect(checkScenario({ ...ok, workerMemoryMaxBytes: 4.1 * GiB }).passed).toBe(false);
    const { workerMemoryMaxBytes: _drop, ...noMemory } = ok;
    expect(checkScenario(noMemory).passed).toBe(false);
  });

  it('checks forwarded p99 at most 10 ms above owner-local', () => {
    const r: ResultFile = {
      schema: 1,
      scenario: 'forwarded-calls',
      startedAt: 'x',
      durationSec: 300,
      achievedRate: 500,
      series: { ownerLocal: flat(5, 10_000), forwarded: flat(14, 10_000) },
      config: {},
    };
    expect(checkScenario(r).passed).toBe(true);
    expect(
      checkScenario({ ...r, series: { ownerLocal: flat(5, 10_000), forwarded: flat(16, 10_000) } })
        .passed,
    ).toBe(false);
  });

  it('aggregates files and fails missing scenarios only with requireAll', () => {
    const good = callsResult(6, 2);
    expect(checkAll([good]).passed).toBe(true);
    const strict = checkAll([good], { requireAll: true });
    expect(strict.passed).toBe(false);
    expect(strict.missing).toContain('listen-streams');
    expect(formatReport(strict)).toContain('TARGETS NOT MET');
    expect(formatReport(checkAll([good]))).toContain('ALL TARGETS MET');
  });

  it('round-trips through the JSON schema, mapping empty statistics to null', () => {
    const stored = fromSummary(summarize([]));
    expect(stored.p99).toBeNull();
    const parsed = resultFileSchema.parse(JSON.parse(JSON.stringify(callsResult(6, 2))));
    expect(parsed.scenario).toBe('call-guards-off');
    expect(() => resultFileSchema.parse({ schema: 2 })).toThrow();
  });
});

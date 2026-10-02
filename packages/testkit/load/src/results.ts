import { z } from 'zod';
import {
  getScenario,
  SCENARIOS,
  type ScenarioDef,
  type ScenarioId,
  type SeriesName,
  type Target,
} from './scenarios';
import { addedLatency, type Summary } from './stats';

/** The JSON file the generator writes and `check` reads (one per scenario run). */

// JSON has no NaN: an empty series stores null for its statistics.
const stat = z.number().nullable();
export const summarySchema = z.object({
  count: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  mean: stat,
  p50: stat,
  p90: stat,
  p95: stat,
  p99: stat,
  max: stat,
});
export type StoredSummary = z.infer<typeof summarySchema>;

export const resultFileSchema = z.object({
  schema: z.literal(1),
  scenario: z.enum([
    'call-guards-off',
    'call-guards-default',
    'list-30',
    'cold-start',
    'listen-streams',
    'forwarded-calls',
  ]),
  startedAt: z.string(),
  durationSec: z.number().nonnegative(),
  /** Offered rate (calls per second), when the scenario is rate based. */
  offeredRate: z.number().nonnegative().optional(),
  /** Calls completed (ok plus errors) divided by wall time. */
  achievedRate: z.number().nonnegative().optional(),
  series: z
    .object({
      via: summarySchema,
      direct: summarySchema,
      ownerLocal: summarySchema,
      forwarded: summarySchema,
    })
    .partial(),
  streams: z
    .object({
      opened: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
      failedToOpen: z.number().int().nonnegative(),
    })
    .optional(),
  /** Highest per-worker memory sample in bytes (filled in with `annotate`, from `kubectl top` or metrics). */
  workerMemoryMaxBytes: z.number().nonnegative().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type ResultFile = z.infer<typeof resultFileSchema>;

export const toSummary = (stored: StoredSummary): Summary => ({
  count: stored.count,
  errors: stored.errors,
  mean: stored.mean ?? Number.NaN,
  p50: stored.p50 ?? Number.NaN,
  p90: stored.p90 ?? Number.NaN,
  p95: stored.p95 ?? Number.NaN,
  p99: stored.p99 ?? Number.NaN,
  max: stored.max ?? Number.NaN,
});

export const fromSummary = (s: Summary): StoredSummary => {
  const n = (v: number): number | null => (Number.isFinite(v) ? v : null);
  return {
    count: s.count,
    errors: s.errors,
    mean: n(s.mean),
    p50: n(s.p50),
    p90: n(s.p90),
    p95: n(s.p95),
    p99: n(s.p99),
    max: n(s.max),
  };
};

export type CheckLine = {
  name: string;
  passed: boolean;
  actual: string;
  expected: string;
  /** True when the threshold is our assumption, not a number from the spec. */
  assumption?: boolean;
};

export type ScenarioVerdict = {
  scenario: ScenarioId;
  row: string;
  passed: boolean;
  lines: CheckLine[];
};

const ms = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)} ms` : 'n/a');

const series = (result: ResultFile, name: SeriesName): Summary | undefined => {
  const stored = result.series[name];
  return stored ? toSummary(stored) : undefined;
};

const evaluateTarget = (result: ResultFile, target: Target): CheckLine => {
  const base = {
    name: target.label,
    ...('assumption' in target && target.assumption ? { assumption: true as const } : {}),
  };
  switch (target.kind) {
    case 'added': {
      const via = series(result, 'via');
      const direct = series(result, 'direct');
      if (!via || !direct)
        return {
          ...base,
          passed: false,
          actual: 'missing via or direct series',
          expected: `< ${target.maxMs} ms`,
        };
      const added = addedLatency(via, direct, target.percentile);
      return {
        ...base,
        passed: Number.isFinite(added) && added < target.maxMs,
        actual: `${ms(added)} (${target.percentile} via ${ms(via[target.percentile])} - direct ${ms(direct[target.percentile])})`,
        expected: `< ${target.maxMs} ms`,
      };
    }
    case 'latency': {
      const via = series(result, 'via');
      const value = via?.[target.percentile] ?? Number.NaN;
      return {
        ...base,
        passed: Number.isFinite(value) && value < target.maxMs,
        actual: ms(value),
        expected: `${target.percentile} < ${target.maxMs} ms`,
      };
    }
    case 'delta': {
      const a = series(result, target.a);
      const b = series(result, target.b);
      if (!a || !b)
        return {
          ...base,
          passed: false,
          actual: `missing ${target.a} or ${target.b} series`,
          expected: `<= ${target.maxMs} ms`,
        };
      const delta = a[target.percentile] - b[target.percentile];
      return {
        ...base,
        passed: Number.isFinite(delta) && delta <= target.maxMs,
        actual: `${ms(delta)} (${target.a} ${ms(a[target.percentile])} - ${target.b} ${ms(b[target.percentile])})`,
        expected: `<= ${target.maxMs} ms`,
      };
    }
    case 'rate': {
      const rate = result.achievedRate;
      return {
        ...base,
        passed: rate !== undefined && rate >= target.minPerSec,
        actual: rate === undefined ? 'missing' : `${rate.toFixed(0)}/s`,
        expected: `>= ${target.minPerSec.toFixed(0)}/s`,
      };
    }
    case 'errorRate': {
      const via = series(result, 'via') ?? series(result, 'forwarded');
      if (!via)
        return {
          ...base,
          passed: false,
          actual: 'no samples',
          expected: `<= ${(target.max * 100).toFixed(2)}%`,
        };
      const total = via.count + via.errors;
      const rate = total === 0 ? 1 : via.errors / total;
      return {
        ...base,
        passed: rate <= target.max,
        actual: `${(rate * 100).toFixed(3)}% (${via.errors} of ${total})`,
        expected: `<= ${(target.max * 100).toFixed(2)}%`,
      };
    }
    case 'noStreamDrops': {
      const s = result.streams;
      if (!s)
        return {
          ...base,
          passed: false,
          actual: 'no stream data',
          expected: `0 drops with >= ${target.minStreams} streams`,
        };
      const passed = s.dropped === 0 && s.failedToOpen === 0 && s.opened >= target.minStreams;
      return {
        ...base,
        passed,
        actual: `${s.opened} opened, ${s.dropped} dropped, ${s.failedToOpen} failed to open`,
        expected: `0 drops, >= ${target.minStreams} opened`,
      };
    }
    case 'memory': {
      const bytes = result.workerMemoryMaxBytes;
      return {
        ...base,
        passed: bytes !== undefined && bytes < target.maxBytes,
        actual:
          bytes === undefined
            ? 'not recorded (run `annotate --worker-memory-max-bytes`)'
            : `${(bytes / 1024 ** 3).toFixed(2)} GiB`,
        expected: `< ${(target.maxBytes / 1024 ** 3).toFixed(0)} GiB`,
      };
    }
  }
};

/** Pure: compares one result file with its scenario's targets. */
export const checkScenario = (
  result: ResultFile,
  def: ScenarioDef = getScenario(result.scenario),
): ScenarioVerdict => {
  const lines: CheckLine[] = [];
  for (const name of def.requiredSeries) {
    const present = result.series[name] !== undefined;
    lines.push({
      name: `series "${name}" present`,
      passed: present,
      actual: present ? 'yes' : 'no',
      expected: 'yes',
    });
  }
  lines.push({
    name: 'run long enough to certify',
    passed: result.durationSec >= def.minDurationSec,
    actual: `${result.durationSec} s`,
    expected: `>= ${def.minDurationSec} s`,
    ...(def.minDurationSec > 0 && def.minDurationSec < 3600 ? { assumption: true as const } : {}),
  });
  if (def.minSamples > 0) {
    const n = result.series.via?.count ?? result.series.forwarded?.count ?? 0;
    lines.push({
      name: 'enough samples',
      passed: n >= def.minSamples,
      actual: String(n),
      expected: `>= ${def.minSamples}`,
      assumption: true,
    });
  }
  for (const target of def.targets) lines.push(evaluateTarget(result, target));
  return { scenario: def.id, row: def.row, passed: lines.every((l) => l.passed), lines };
};

export type Report = { passed: boolean; verdicts: ScenarioVerdict[]; missing: ScenarioId[] };

/** Pure: checks many result files; with `requireAll` a scenario without a result fails the report. */
export const checkAll = (
  results: readonly ResultFile[],
  opts: { requireAll?: boolean } = {},
): Report => {
  const verdicts = results.map((r) => checkScenario(r));
  const seen = new Set(results.map((r) => r.scenario));
  const missing = opts.requireAll ? SCENARIOS.map((s) => s.id).filter((id) => !seen.has(id)) : [];
  return { passed: verdicts.every((v) => v.passed) && missing.length === 0, verdicts, missing };
};

export const formatReport = (report: Report): string => {
  const out: string[] = [];
  for (const v of report.verdicts) {
    out.push(`${v.passed ? 'PASS' : 'FAIL'}  ${v.scenario}  (${v.row})`);
    for (const l of v.lines) {
      out.push(
        `  ${l.passed ? 'ok  ' : 'FAIL'} ${l.name}${l.assumption ? ' [assumed threshold]' : ''}: ${l.actual}; expected ${l.expected}`,
      );
    }
  }
  for (const id of report.missing) out.push(`FAIL  ${id}  (no result file)`);
  out.push(report.passed ? 'ALL TARGETS MET' : 'TARGETS NOT MET');
  return out.join('\n');
};

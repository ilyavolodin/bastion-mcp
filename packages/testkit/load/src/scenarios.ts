import type { Percentile } from './stats';

/**
 * One scenario per row of tdd 23.4. Targets are data, so the results checker and the generator share them.
 * Where the spec is silent (error budget, minimum run length) the value is marked `assumption`.
 */

export type SeriesName = 'via' | 'direct' | 'ownerLocal' | 'forwarded';

export type Target =
  /** Latency Bastion adds over a direct call to the same upstream: via minus direct at a percentile. */
  | { kind: 'added'; percentile: Percentile; maxMs: number; label: string }
  /** Absolute latency of the `via` series. */
  | { kind: 'latency'; percentile: Percentile; maxMs: number; label: string }
  /** Latency difference between two series (forwarded vs owner-local). */
  | {
      kind: 'delta';
      a: SeriesName;
      b: SeriesName;
      percentile: Percentile;
      maxMs: number;
      label: string;
    }
  /** Achieved request rate at least `minPerSec`. */
  | { kind: 'rate'; minPerSec: number; label: string }
  /** Fraction of failed calls at most `max`. */
  | { kind: 'errorRate'; max: number; label: string; assumption?: true }
  /** No listen stream may end other than by our own close. */
  | { kind: 'noStreamDrops'; minStreams: number; label: string }
  /** Highest worker memory sample (bytes) at most `maxBytes`. */
  | { kind: 'memory'; maxBytes: number; label: string };

export type ScenarioId =
  | 'call-guards-off'
  | 'call-guards-default'
  | 'list-30'
  | 'cold-start'
  | 'listen-streams'
  | 'forwarded-calls';

export type ScenarioDef = {
  id: ScenarioId;
  /** The row of tdd 23.4 this scenario checks. */
  row: string;
  describe: string;
  /** Default offered load (calls per second, streams, or iterations). */
  defaults: { rate?: number; streams?: number; iterations?: number; durationSec: number };
  /** Runs shorter than this cannot certify the target (assumption unless noted in the label). */
  minDurationSec: number;
  /** Minimum number of successful samples in the `via` series. */
  minSamples: number;
  /** Series the run must contain. */
  requiredSeries: readonly SeriesName[];
  targets: readonly Target[];
  /** Deployment the scenario assumes. */
  topology: string;
};

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'call-guards-off',
    row: 'tools/call to warm remote upstream, guards off',
    describe:
      'Open-loop tools/call against a fake remote upstream through /mcp/i/<slug> with the guard profile disabled.',
    defaults: { rate: 2000, durationSec: 300 },
    minDurationSec: 60,
    minSamples: 10_000,
    requiredSeries: ['via', 'direct'],
    topology: '3 workers',
    targets: [
      { kind: 'added', percentile: 'p50', maxMs: 5, label: 'added p50 under 5 ms' },
      { kind: 'added', percentile: 'p99', maxMs: 25, label: 'added p99 under 25 ms' },
      {
        kind: 'rate',
        minPerSec: 2000 * 0.98,
        label: 'sustains 2,000 calls/s (98% tolerance for pacing jitter)',
      },
      { kind: 'errorRate', max: 0.001, label: 'error rate at most 0.1%', assumption: true },
    ],
  },
  {
    id: 'call-guards-default',
    row: 'same with default deterministic guards',
    describe:
      'As call-guards-off with the shipped default guard profile enabled (unicode, size, regex secrets and injection heuristics).',
    defaults: { rate: 2000, durationSec: 300 },
    minDurationSec: 60,
    minSamples: 10_000,
    requiredSeries: ['via', 'direct'],
    topology: '3 workers',
    targets: [
      { kind: 'added', percentile: 'p99', maxMs: 30, label: 'added p99 under 30 ms' },
      {
        kind: 'rate',
        minPerSec: 2000 * 0.98,
        label: 'sustains 2,000 calls/s (98% tolerance for pacing jitter)',
      },
      { kind: 'errorRate', max: 0.001, label: 'error rate at most 0.1%', assumption: true },
    ],
  },
  {
    id: 'list-30',
    row: 'tools/list on a 30-installation endpoint, warm',
    describe:
      'tools/list against a named endpoint that aggregates 30 installations, after the list cache is warm.',
    defaults: { rate: 200, durationSec: 120 },
    minDurationSec: 30,
    minSamples: 2_000,
    requiredSeries: ['via'],
    topology: '3 workers',
    targets: [
      { kind: 'latency', percentile: 'p99', maxMs: 40, label: 'p99 under 40 ms' },
      { kind: 'errorRate', max: 0.001, label: 'error rate at most 0.1%', assumption: true },
    ],
  },
  {
    id: 'cold-start',
    row: 'cold sandbox start, warm pool, cached mirror',
    describe:
      'First tools/call on installations whose sandbox is absent; the SandboxWarmPool is full and the package mirror is cached.',
    defaults: { iterations: 40, durationSec: 600 },
    minDurationSec: 0,
    minSamples: 30,
    requiredSeries: ['via'],
    topology: 'kind or GKE Sandbox with warm pool replicas >= iterations in flight',
    targets: [
      { kind: 'latency', percentile: 'p95', maxMs: 4000, label: 'p95 under 4 s' },
      { kind: 'errorRate', max: 0.0, label: 'no failed starts', assumption: true },
    ],
  },
  {
    id: 'listen-streams',
    row: '5,000 concurrent listen streams across 6 workers',
    describe:
      'Opens subscriptions/listen streams and holds them; counts any stream that ends without our own close.',
    defaults: { streams: 5000, durationSec: 3600 },
    minDurationSec: 3600,
    minSamples: 0,
    requiredSeries: [],
    topology: '6 workers',
    targets: [
      {
        kind: 'noStreamDrops',
        minStreams: 5000,
        label: 'no stream drops over 1 hour with 5,000 streams',
      },
      { kind: 'memory', maxBytes: 4 * GiB, label: 'memory per worker under 4 GiB' },
    ],
  },
  {
    id: 'forwarded-calls',
    row: 'forwarded calls (non-owner worker)',
    describe:
      'The same tool call sent to the instance owner pod and to a non-owner pod (forwarded over internal RPC).',
    defaults: { rate: 500, durationSec: 300 },
    minDurationSec: 60,
    minSamples: 5_000,
    requiredSeries: ['ownerLocal', 'forwarded'],
    topology: '3 workers, pod-addressable URLs',
    targets: [
      {
        kind: 'delta',
        a: 'forwarded',
        b: 'ownerLocal',
        percentile: 'p99',
        maxMs: 10,
        label: 'forwarded p99 at most 10 ms above owner-local',
      },
      { kind: 'errorRate', max: 0.001, label: 'error rate at most 0.1%', assumption: true },
    ],
  },
];

export const scenarioIds = (): ScenarioId[] => SCENARIOS.map((s) => s.id);

export const getScenario = (id: string): ScenarioDef => {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found)
    throw new Error(`unknown scenario "${id}"; expected one of ${scenarioIds().join(', ')}`);
  return found;
};

export { GiB, MiB };

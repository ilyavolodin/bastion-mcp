/**
 * Views over the observability routes (15.5, 13.6): the call log, the rollup statistics, security findings and drift
 * reviews. Every type is the generated one (`Schemas`, `Res`, `Query`); what lives here is what the screens derive
 * from them (time slots, outcome groups, joined names, the worst guard verdict).
 */
import type { Body, CallOutcome, Query, Res, Schemas } from '../schema';

export type CallRow = Schemas['CallRecord'];
export type GuardResult = NonNullable<CallRow['guardResults']>[number];
export type DriftRow = Schemas['DriftReview'];
export type FindingRow = Schemas['Finding'];
type Series = Res<'get', '/stats/calls'>;

// --- time ranges and filters ----------------------------------------------------------------------------------

export type StatsRange = '1h' | '24h' | '7d' | '14d' | '90d';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const RANGE_MS: Record<StatsRange, number> = {
  '1h': HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '14d': 14 * DAY,
  '90d': 90 * DAY,
};

export type Bucket = 'minute' | 'hour' | 'day';
export const BUCKET_MS: Record<Bucket, number> = { minute: MINUTE, hour: HOUR, day: DAY };

/** Chart resolution per range: a minute for the last hour, an hour for a day, a day beyond. */
export const bucketFor = (range: StatsRange): Bucket =>
  range === '1h' ? 'minute' : range === '24h' ? 'hour' : 'day';

export const rangeWindow = (range: StatsRange, now: number = Date.now()) => ({
  from: new Date(now - RANGE_MS[range]).toISOString(),
  to: new Date(now).toISOString(),
});

/** What the Activity filters hold (UI state, not an API body); `callsQuery` turns it into the request. */
export type CallFilters = {
  user?: string | undefined;
  team?: string | undefined;
  installationId?: string | undefined;
  item?: string | undefined;
  outcome?: CallOutcome | undefined;
  range?: '1h' | '24h' | '7d' | undefined;
};

/** The caller as the call log's authorization sees them (`GET /calls` rules logs.org, logs.team, logs.user). */
export type CallViewer = {
  id: string;
  orgRole: string;
  teams: { id: string; role: string }[];
};

export const viewerSeesOrg = (v: CallViewer): boolean =>
  v.orgRole === 'admin' || v.orgRole === 'auditor';
export const managedTeam = (v: CallViewer): string | undefined =>
  v.teams.find((t) => t.role === 'manager')?.id;

/**
 * Narrows the filters to what the caller may read: the API answers `GET /calls` without a person or team only to
 * admins and auditors, a team to its managers and a person to themselves, so members always ask for their own calls
 * and managers for their team's.
 */
export const scopedFilters = (viewer: CallViewer, filters: CallFilters): CallFilters => {
  if (viewerSeesOrg(viewer)) return filters;
  if (filters.user || filters.team) return filters;
  const team = managedTeam(viewer);
  return team ? { ...filters, team } : { ...filters, user: viewer.id };
};

export const callsQuery = (
  filters: CallFilters,
  now: number = Date.now(),
): Query<'get', '/calls'> => ({
  ...(filters.user ? { user: filters.user } : {}),
  ...(filters.team ? { team: filters.team } : {}),
  ...(filters.installationId ? { installation: filters.installationId } : {}),
  ...(filters.item ? { item: filters.item } : {}),
  ...(filters.outcome ? { outcome: filters.outcome } : {}),
  ...rangeWindow(filters.range ?? '24h', now),
});

// --- call series ---------------------------------------------------------------------------------------------

export type CallBucket = {
  t: string;
  calls: number;
  errors: number;
  ok: number;
  upstreamError: number;
  denied: number;
  blocked: number;
  /** Only known when the series is built from call rows; the rollups carry no cold starts. */
  coldStarts: number;
};
export type CallSeries = { buckets: CallBucket[]; trend: 'up' | 'down' | 'flat' };

/** Outcomes that count as a success (an `input_required` round is not a failure). */
export const isSuccess = (o: CallOutcome): boolean => o === 'ok' || o === 'input_required';

const emptyBucket = (t: string): CallBucket => ({
  t,
  calls: 0,
  errors: 0,
  ok: 0,
  upstreamError: 0,
  denied: 0,
  blocked: 0,
  coldStarts: 0,
});

/** Adds `count` calls of one outcome to a bucket. */
export const tally = (b: CallBucket, outcome: CallOutcome, count: number): void => {
  b.calls += count;
  if (isSuccess(outcome)) b.ok += count;
  else {
    b.errors += count;
    if (outcome === 'blocked') b.blocked += count;
    else if (outcome === 'denied' || outcome === 'rate_limited') b.denied += count;
    else b.upstreamError += count;
  }
};

/** Every slot between `from` and `to`, so the chart has no holes. */
export const slots = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let t = Math.floor(from / step) * step; t <= to; t += step) out.push(t);
  return out;
};

export const trendOf = (buckets: readonly { calls: number }[]): CallSeries['trend'] => {
  const half = Math.floor(buckets.length / 2);
  if (half === 0) return 'flat';
  const sum = (xs: readonly { calls: number }[]) => xs.reduce((a, b) => a + b.calls, 0);
  const before = sum(buckets.slice(0, half));
  const after = sum(buckets.slice(buckets.length - half));
  if (after > before * 1.1) return 'up';
  if (after < before * 0.9) return 'down';
  return 'flat';
};

const asOutcome = (g: string | null): CallOutcome => (g as CallOutcome | null) ?? 'ok';

/** `GET /stats/calls?groupBy=outcome` as per-slot call counts by outcome. */
export const seriesFromStats = (
  stats: Series,
  window: { from: number; to: number; step: number },
): CallSeries => {
  const byTs = new Map(
    slots(window.from, window.to, window.step).map((t) => [
      t,
      emptyBucket(new Date(t).toISOString()),
    ]),
  );
  for (const b of stats.buckets) {
    const key = Math.floor(new Date(b.ts).getTime() / window.step) * window.step;
    const slot = byTs.get(key);
    if (slot) tally(slot, asOutcome(b.group), b.values.count ?? 0);
  }
  const buckets = [...byTs.values()];
  return { buckets, trend: trendOf(buckets) };
};

/** The same series from call rows (installation and personal views, which the rollups cannot filter). */
export const seriesFromCalls = (
  rows: readonly CallRow[],
  window: { from: number; to: number; step: number },
): CallSeries => {
  const byTs = new Map(
    slots(window.from, window.to, window.step).map((t) => [
      t,
      emptyBucket(new Date(t).toISOString()),
    ]),
  );
  for (const r of rows) {
    const key = Math.floor(new Date(r.ts).getTime() / window.step) * window.step;
    const slot = byTs.get(key);
    if (!slot) continue;
    tally(slot, r.outcome, 1);
    if (r.coldStart) slot.coldStarts += 1;
  }
  const buckets = [...byTs.values()];
  return { buckets, trend: trendOf(buckets) };
};

// --- latency, grouping, guards, sandboxes ------------------------------------------------------------------------

export type LatencyPoint = { t: string; count: number; p50: number; p95: number; p99: number };

export const latencyPoints = (stats: Res<'get', '/stats/latency'>): LatencyPoint[] =>
  stats.buckets.map((b) => ({
    t: b.ts,
    count: b.values.count ?? 0,
    p50: b.values.p50 ?? 0,
    p95: b.values.p95 ?? 0,
    p99: b.values.p99 ?? 0,
  }));

export type GroupTotal = { group: string; calls: number; errors: number; errorRate: number };

/** `GET /stats/calls?groupBy=installation|item` summed over time, busiest first. */
export const totalsByGroup = (stats: Series): GroupTotal[] => {
  const by = new Map<string, { calls: number; errors: number }>();
  for (const b of stats.buckets) {
    if (b.group === null) continue;
    const cur = by.get(b.group) ?? { calls: 0, errors: 0 };
    cur.calls += b.values.count ?? 0;
    cur.errors += b.values.errors ?? 0;
    by.set(b.group, cur);
  }
  return [...by.entries()]
    .map(([group, v]) => ({
      group,
      ...v,
      errorRate: v.calls === 0 ? 0 : v.errors / v.calls,
    }))
    .sort((a, b) => b.calls - a.calls);
};

export type Verdict = 'clean' | 'suspicious' | 'malicious' | 'error';
export const VERDICTS: readonly Verdict[] = ['clean', 'suspicious', 'malicious', 'error'];

export type GuardTotals = {
  guard: string;
  clean: number;
  suspicious: number;
  malicious: number;
  error: number;
  flagged: number;
};

/** `GET /stats/guards` (group = guard, values per verdict) summed over time, most flagged first. */
export const guardTotals = (stats: Res<'get', '/stats/guards'>): GuardTotals[] => {
  const by = new Map<string, GuardTotals>();
  for (const b of stats.buckets) {
    if (b.group === null) continue;
    const row = by.get(b.group) ?? {
      guard: b.group,
      clean: 0,
      suspicious: 0,
      malicious: 0,
      error: 0,
      flagged: 0,
    };
    for (const v of VERDICTS) row[v] += b.values[v] ?? 0;
    row.flagged = row.suspicious + row.malicious + row.error;
    by.set(b.group, row);
  }
  return [...by.values()].sort((a, b) => b.flagged - a.flagged);
};

export type GuardSlot = { t: string; suspicious: number; malicious: number; error: number };

/** Flagged results per slot, whichever guard flagged them. */
export const guardSlots = (stats: Res<'get', '/stats/guards'>): GuardSlot[] => {
  const by = new Map<string, GuardSlot>();
  for (const b of stats.buckets) {
    const slot = by.get(b.ts) ?? { t: b.ts, suspicious: 0, malicious: 0, error: 0 };
    slot.suspicious += b.values.suspicious ?? 0;
    slot.malicious += b.values.malicious ?? 0;
    slot.error += b.values.error ?? 0;
    by.set(b.ts, slot);
  }
  return [...by.values()].sort((a, b) => a.t.localeCompare(b.t));
};

export type SandboxSlot = { t: string; starts: number; failures: number };
export type SandboxSeries = {
  drivers: string[];
  slots: SandboxSlot[];
  starts: number;
  failures: number;
};

export const sandboxSeries = (stats: Res<'get', '/stats/sandboxes'>): SandboxSeries => {
  const by = new Map<string, SandboxSlot>();
  const drivers = new Set<string>();
  for (const b of stats.buckets) {
    if (b.group) drivers.add(b.group);
    const slot = by.get(b.ts) ?? { t: b.ts, starts: 0, failures: 0 };
    slot.starts += b.values.starts ?? 0;
    slot.failures += b.values.failures ?? 0;
    by.set(b.ts, slot);
  }
  const all = [...by.values()].sort((a, b) => a.t.localeCompare(b.t));
  return {
    drivers: [...drivers],
    slots: all,
    starts: all.reduce((a, s) => a + s.starts, 0),
    failures: all.reduce((a, s) => a + s.failures, 0),
  };
};

// --- one call -------------------------------------------------------------------------------------------------

export const callTitle = (c: CallRow): string => c.itemName ?? c.method;

/** A JSON preview column as text (`null` when the call logged none). */
export const previewText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

export const traceHref = (
  base: string | null | undefined,
  traceId: string | null,
): string | null => (base && traceId ? `${base.replace(/\/$/, '')}/${traceId}` : null);

/** The worst verdict among guard results (`error` ranks below `suspicious`: a failed guard proves nothing). */
export const worstVerdict = (results: readonly { verdict: Verdict }[]): Verdict => {
  if (results.some((r) => r.verdict === 'malicious')) return 'malicious';
  if (results.some((r) => r.verdict === 'suspicious')) return 'suspicious';
  if (results.some((r) => r.verdict === 'error')) return 'error';
  return 'clean';
};

export const GUARD_ACTION_LABEL = (action: string): string =>
  action === 'block'
    ? 'Blocked'
    : action === 'redact'
      ? 'Redacted'
      : action === 'quarantine'
        ? 'Quarantined'
        : action === 'warn' || action === 'confirm'
          ? 'Warned'
          : 'Allowed';

/** Guard results that flagged something (clean results are noise in the drawer). */
export const flaggedResults = (c: CallRow): GuardResult[] =>
  (c.guardResults ?? []).filter((r) => r.verdict !== 'clean');

// --- findings ----------------------------------------------------------------------------------------------------

export const FINDING_KIND_LABEL: Record<FindingRow['kind'], string> = {
  guard_block: 'Blocked by a guard',
  drift: 'Definition changed',
  egress_denied: 'Network access denied',
};

export type Names = {
  users: ReadonlyMap<string, string>;
  installations: ReadonlyMap<string, string>;
};

export type FindingView = FindingRow & { subjectName: string | null };

/** A finding's subject is a person (guard blocks), an installation (drift) or an instance (egress); name what we can. */
export const findingViews = (rows: readonly FindingRow[], names: Names): FindingView[] =>
  rows.map((f) => ({
    ...f,
    subjectName:
      f.subject === null
        ? null
        : f.kind === 'guard_block'
          ? (names.users.get(f.subject) ?? null)
          : f.kind === 'drift'
            ? (names.installations.get(f.subject) ?? null)
            : null,
  }));

// --- drift reviews -----------------------------------------------------------------------------------------------

export type DriftView = DriftRow & {
  serverName: string;
  /** The changed item's description, when its definition has one. */
  description: string;
  verdict: Verdict;
  scanMessage: string;
  risk: 'low' | 'medium' | 'high';
};

export const descriptionOf = (definition: Record<string, unknown>): string =>
  typeof definition.description === 'string' ? definition.description : '';

export const scanMessage = (results: readonly GuardResult[]): string => {
  const verdict = worstVerdict(results);
  if (results.length === 0) return 'No guard has scanned this definition.';
  if (verdict === 'clean')
    return `${results.length} ${results.length === 1 ? 'guard found' : 'guards found'} nothing in this definition.`;
  const flagged = results.filter((r) => r.verdict === verdict).map((r) => r.guard);
  return verdict === 'error'
    ? `${flagged.join(', ')} could not scan this definition.`
    : `${flagged.join(', ')} flagged this definition as ${verdict}.`;
};

export const driftViews = (
  rows: readonly DriftRow[],
  installations: ReadonlyMap<string, string>,
): DriftView[] =>
  rows.map((r) => {
    const verdict = worstVerdict(r.guardResults);
    return {
      ...r,
      serverName: (r.installationId && installations.get(r.installationId)) || 'Unknown server',
      description: descriptionOf(r.newDefinition),
      verdict,
      scanMessage: scanMessage(r.guardResults),
      risk: verdict === 'malicious' ? 'high' : verdict === 'suspicious' ? 'medium' : 'low',
    };
  });

/** A drift decision with the body it sends (`POST /drift-reviews/{id}/approve|reject`). */
export type DriftDecision =
  | { id: string; decision: 'approve'; body: Body<'post', '/drift-reviews/{id}/approve'> }
  | { id: string; decision: 'reject'; body: Body<'post', '/drift-reviews/{id}/reject'> };

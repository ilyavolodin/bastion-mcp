import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  type CallRow,
  callsQuery,
  driftViews,
  findingViews,
  guardTotals,
  latencyPoints,
  previewText,
  sandboxSeries,
  scanMessage,
  scopedFilters,
  seriesFromCalls,
  seriesFromStats,
  totalsByGroup,
  traceHref,
  trendOf,
  worstVerdict,
} from '@/api/views/observability';
import { resetDb } from '@/mocks/db';
import { buildObservabilityData, observabilitySamples } from '@/mocks/domains/observability';
import openapi from '../../../../packages/api-client/openapi.json';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 5, 1, 10);
const ts = (h: number) => new Date(T0 + h * HOUR).toISOString();

describe('observability views (15.5, 13.6, 17.2)', () => {
  it('10.1 asks only for what the call log lets the caller read', () => {
    const member = { id: 'u-1', orgRole: 'member', teams: [{ id: 't-1', role: 'member' }] };
    const manager = { id: 'u-2', orgRole: 'member', teams: [{ id: 't-9', role: 'manager' }] };
    const admin = { id: 'u-3', orgRole: 'admin', teams: [] };
    expect(scopedFilters(member, {})).toEqual({ user: 'u-1' });
    expect(scopedFilters(manager, { outcome: 'ok' })).toEqual({ outcome: 'ok', team: 't-9' });
    expect(scopedFilters(manager, { user: 'u-5' })).toEqual({ user: 'u-5' });
    expect(scopedFilters(admin, {})).toEqual({});
  });

  it('17.2 maps the Activity filters to the API query names and a time window', () => {
    const q = callsQuery(
      { user: 'u', team: 't', installationId: 'i', item: 'pg', outcome: 'blocked', range: '1h' },
      T0,
    );
    expect(q).toMatchObject({
      user: 'u',
      team: 't',
      installation: 'i',
      item: 'pg',
      outcome: 'blocked',
    });
    expect(q.to).toBe(ts(0));
    expect(q.from).toBe(ts(-1));
  });

  it('15.5 builds calls over time from the rollup grouped by outcome, with no holes', () => {
    const series = seriesFromStats(
      {
        buckets: [
          { ts: ts(0), group: 'ok', values: { count: 8 } },
          { ts: ts(0), group: 'denied', values: { count: 1 } },
          { ts: ts(0), group: 'blocked', values: { count: 1 } },
          { ts: ts(2), group: 'error', values: { count: 2 } },
          { ts: ts(2), group: 'input_required', values: { count: 3 } },
        ],
      },
      { from: T0, to: T0 + 3 * HOUR, step: BUCKET_MS.hour },
    );
    expect(series.buckets.map((b) => b.calls)).toEqual([10, 0, 5, 0]);
    expect(series.buckets[0]).toMatchObject({ ok: 8, denied: 1, blocked: 1, errors: 2 });
    expect(series.buckets[2]).toMatchObject({ ok: 3, upstreamError: 2, errors: 2 });
  });

  it('15.5 builds the same series from call rows and counts cold starts', () => {
    const rows = [
      { ts: ts(0), outcome: 'ok', coldStart: true },
      { ts: ts(0), outcome: 'tool_error', coldStart: false },
      { ts: ts(1), outcome: 'rate_limited', coldStart: false },
    ] as CallRow[];
    const series = seriesFromCalls(rows, { from: T0, to: T0 + HOUR, step: BUCKET_MS.hour });
    expect(series.buckets[0]).toMatchObject({ calls: 2, ok: 1, upstreamError: 1, coldStarts: 1 });
    expect(series.buckets[1]).toMatchObject({ calls: 1, denied: 1 });
  });

  it('derives a trend from the second half against the first', () => {
    expect(trendOf([{ calls: 10 }, { calls: 10 }, { calls: 20 }, { calls: 20 }])).toBe('up');
    expect(trendOf([{ calls: 20 }, { calls: 20 }, { calls: 10 }, { calls: 10 }])).toBe('down');
    expect(trendOf([{ calls: 10 }, { calls: 10 }, { calls: 10 }, { calls: 10 }])).toBe('flat');
    expect(trendOf([{ calls: 5 }])).toBe('flat');
  });

  it('15.5 sums statistics per server and per guard, busiest and most flagged first', () => {
    const calls = totalsByGroup({
      buckets: [
        { ts: ts(0), group: 'i-a', values: { count: 10, errors: 1 } },
        { ts: ts(1), group: 'i-a', values: { count: 10, errors: 3 } },
        { ts: ts(0), group: 'i-b', values: { count: 30, errors: 0 } },
      ],
    });
    expect(calls.map((c) => c.group)).toEqual(['i-b', 'i-a']);
    expect(calls[1]).toMatchObject({ calls: 20, errors: 4, errorRate: 0.2 });
    const guards = guardTotals({
      buckets: [
        { ts: ts(0), group: 'regex', values: { clean: 5, malicious: 2 } },
        { ts: ts(1), group: 'regex', values: { suspicious: 1 } },
        { ts: ts(0), group: 'pii', values: { clean: 9 } },
      ],
    });
    expect(guards[0]).toMatchObject({ guard: 'regex', flagged: 3, clean: 5 });
    expect(guards[1]).toMatchObject({ guard: 'pii', flagged: 0 });
  });

  it('15.5 reads latency percentiles and sandbox starts from the series', () => {
    expect(
      latencyPoints({
        buckets: [{ ts: ts(0), group: null, values: { count: 4, p50: 90, p95: 300, p99: 500 } }],
      }),
    ).toEqual([{ t: ts(0), count: 4, p50: 90, p95: 300, p99: 500 }]);
    const sb = sandboxSeries({
      buckets: [
        { ts: ts(0), group: 'kubernetes-gvisor', values: { starts: 3, failures: 1 } },
        { ts: ts(1), group: 'kubernetes-gvisor', values: { starts: 2, failures: 0 } },
      ],
    });
    expect(sb).toMatchObject({ drivers: ['kubernetes-gvisor'], starts: 5, failures: 1 });
  });

  it('13.1 ranks guard verdicts and explains the scan in words', () => {
    const r = (guard: string, verdict: 'clean' | 'suspicious' | 'malicious' | 'error') => ({
      guard,
      verdict,
    });
    expect(worstVerdict([r('a', 'clean'), r('b', 'error')])).toBe('error');
    expect(worstVerdict([r('a', 'error'), r('b', 'suspicious')])).toBe('suspicious');
    expect(worstVerdict([r('a', 'suspicious'), r('b', 'malicious')])).toBe('malicious');
    expect(worstVerdict([])).toBe('clean');
    const full = (guard: string, verdict: 'clean' | 'malicious') => ({
      guard,
      verdict,
      type: 'regex',
      phase: 'definition' as const,
      action: 'block',
      latencyMs: 1,
      mode: 'blocking' as const,
    });
    expect(scanMessage([])).toMatch(/No guard has scanned/);
    expect(scanMessage([full('judge', 'malicious')])).toBe(
      'judge flagged this definition as malicious.',
    );
    expect(scanMessage([full('a', 'clean'), full('b', 'clean')])).toMatch(/2 guards found nothing/);
  });

  it('13.6 joins server names into drift reviews and rates their risk from the verdict', () => {
    const rows = buildObservabilityData(T0).drift;
    const views = driftViews(rows, new Map([['i-sentry', 'Sentry']]));
    const sentry = views.find((v) => v.id === 'dr-1');
    expect(sentry).toMatchObject({ serverName: 'Sentry', verdict: 'malicious', risk: 'high' });
    expect(sentry?.description).toMatch(/slack_post_message/);
    expect(views.find((v) => v.id === 'dr-2')).toMatchObject({
      serverName: 'Unknown server',
      risk: 'low',
    });
  });

  it('13.6 names the subject of a finding when it is a person or a server', () => {
    const names = {
      users: new Map([['u-raj', 'Raj Mehta']]),
      installations: new Map([['i-sentry', 'Sentry']]),
    };
    const out = findingViews(
      [
        { id: '1', ts: ts(0), kind: 'guard_block', subject: 'u-raj', detail: 'pg_run_query' },
        { id: '2', ts: ts(0), kind: 'drift', subject: 'i-sentry', detail: 'get_event' },
        { id: '3', ts: ts(0), kind: 'egress_denied', subject: 'inst-1', detail: 'x:443' },
      ],
      names,
    );
    expect(out.map((f) => f.subjectName)).toEqual(['Raj Mehta', 'Sentry', null]);
  });

  it('formats previews and tracing links', () => {
    expect(previewText(null)).toBeNull();
    expect(previewText('text')).toBe('text');
    expect(previewText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(traceHref('https://traces.acme.dev/trace/', 'abc')).toBe(
      'https://traces.acme.dev/trace/abc',
    );
    expect(traceHref(null, 'abc')).toBeNull();
    expect(traceHref('https://t', null)).toBeNull();
  });

  it('17.2 every sample request uses only query parameters the operation declares', () => {
    const paths = (
      openapi as unknown as {
        paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
      }
    ).paths;
    for (const s of observabilitySamples(resetDb('admin'))) {
      const url = new URL(s.path, 'http://x');
      const template = Object.keys(paths).find((p) =>
        new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname),
      );
      expect(template, s.path).toBeDefined();
      const declared = new Set(
        (paths[template ?? '']?.[s.method]?.parameters ?? [])
          .filter((p) => p.in === 'query')
          .map((p) => p.name),
      );
      for (const name of url.searchParams.keys())
        expect(declared, `${s.path}: ${name}`).toContain(name);
    }
  });
});

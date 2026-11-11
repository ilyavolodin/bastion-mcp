import { Link } from '@tanstack/react-router';
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import {
  type StatsScope,
  useCallTotals,
  useLatency,
  useNames,
  useSandboxes,
  useSandboxStats,
} from '@/api/hooks';
import type { GroupTotal, StatsRange } from '@/api/views/observability';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dateLabel, GRID, hourLabel } from '@/components/charts';
import { Card, CardHeader, Legend, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { HEALTH_LABEL, healthTone, StatusDot } from '@/components/status';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatDuration, formatNumber, formatRelative } from '@/lib/format';

type Args = { range: StatsRange } & StatsScope;
const axisLabel = (range: StatsRange) =>
  range === '7d' || range === '14d' || range === '90d' ? dateLabel : hourLabel;

const CALLS_LEGEND: { label: string; color: string; shape: 'bar' }[] = [
  { label: 'Succeeded', color: 'var(--sky)', shape: 'bar' },
  { label: 'Errors', color: 'var(--coral)', shape: 'bar' },
];

/** A row's calls as a bar, `max` being the busiest row's calls: the succeeded part first, then the errors. */
function CallsBar({ calls, errors, max }: { calls: number; errors: number; max: number }) {
  return (
    <span className="flex h-4 overflow-hidden rounded-sm bg-sunken" aria-hidden="true">
      <span
        className="block h-full"
        style={{ width: `${((calls - errors) / max) * 100}%`, background: 'var(--sky)' }}
      />
      <span
        className="block h-full"
        style={{ width: `${(errors / max) * 100}%`, background: 'var(--coral)' }}
      />
    </span>
  );
}

/** Totals per server with the server's name (the rollups group by installation id). */
const useServerTotals = (args: Args) => {
  const totals = useCallTotals(args, 'installation');
  const names = useNames();
  const named = (g: GroupTotal) => names.data?.installations.get(g.group) ?? g.group;
  return { totals, named };
};

// --- Where calls go ---------------------------------------------------------------------------------------
export function TrafficPanel({ args }: { args: Args }) {
  const { totals, named } = useServerTotals(args);
  const max = Math.max(1, ...(totals.data ?? []).map((t) => t.calls));
  return (
    <ChartCard
      title="Where calls go"
      interactive
      legend={<Legend items={CALLS_LEGEND} />}
      table={{
        columns: ['Server', 'Calls', 'Errors'],
        rows: (totals.data ?? []).map((t) => [named(t), t.calls, t.errors]),
      }}
    >
      <QueryBoundary query={totals} skeleton={<Skeleton className="h-[320px] w-full" />}>
        {(items) => (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {items.map((t) => (
              <li
                key={t.group}
                className="grid grid-cols-[140px_minmax(0,1fr)_64px] items-center gap-3"
                title={`${named(t)}: ${formatNumber(t.calls)} calls, ${formatNumber(t.errors)} errors`}
              >
                <Link
                  to={`/servers/${t.group}`}
                  className="truncate text-body-sm font-medium no-underline"
                >
                  {named(t)}
                </Link>
                <CallsBar calls={t.calls} errors={t.errors} max={max} />
                <span className="text-right text-caption tabular-nums text-muted">
                  {formatNumber(t.calls)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Busiest people --------------------------------------------------------------------------------------
/**
 * Calls per person, busiest first (Admin and Auditor, and the managers of a team for their team). A name opens that
 * person's own traffic view; "Calls" opens their call list.
 */
export function PeoplePanel({ args }: { args: Args }) {
  const totals = useCallTotals(args, 'user');
  const names = useNames();
  const nameOf = (id: string) => names.data?.users.get(id) ?? id;
  const top = (totals.data ?? []).slice(0, 10);
  const max = Math.max(1, ...top.map((t) => t.calls));
  return (
    <ChartCard
      title="Busiest people"
      interactive
      legend={<Legend items={CALLS_LEGEND} />}
      table={{
        columns: ['Person', 'Calls', 'Errors'],
        rows: top.map((t) => [nameOf(t.group), t.calls, t.errors]),
      }}
    >
      <QueryBoundary
        query={totals}
        isEmpty={(items) => items.length === 0}
        empty={
          <p className="m-0 py-10 text-center text-muted">Nobody has made a call in this time.</p>
        }
        skeleton={<Skeleton className="h-[320px] w-full" />}
      >
        {() => (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {top.map((t) => (
              <li
                key={t.group}
                className="grid grid-cols-[140px_minmax(0,1fr)_64px_56px] items-center gap-3"
                title={`${nameOf(t.group)}: ${formatNumber(t.calls)} calls, ${formatNumber(t.errors)} errors`}
              >
                <Link
                  to="/observability"
                  search={{ range: args.range, scope: 'person', person: t.group } as never}
                  className="truncate text-body-sm font-medium no-underline"
                >
                  {nameOf(t.group)}
                </Link>
                <CallsBar calls={t.calls} errors={t.errors} max={max} />
                <span className="text-right text-caption tabular-nums text-muted">
                  {formatNumber(t.calls)}
                </span>
                <Link
                  to="/activity"
                  search={{ user: t.group, range: args.range } as never}
                  aria-label={`Calls of ${nameOf(t.group)}`}
                  className="text-right text-caption no-underline"
                >
                  Calls
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Server health map -----------------------------------------------------------------------------------
export function HealthPanel({ args }: { args: Args }) {
  const { totals, named } = useServerTotals(args);
  const items = totals.data ?? [];
  const max = Math.max(1, ...items.map((i) => i.calls));
  const span = (calls: number) => {
    const r = calls / max;
    return r > 0.66
      ? { c: 3, r: 2 }
      : r > 0.33
        ? { c: 2, r: 2 }
        : r > 0.15
          ? { c: 2, r: 1 }
          : { c: 1, r: 1 };
  };
  return (
    <ChartCard
      title="Server health"
      interactive
      legend={<span className="text-caption text-muted">Size = traffic</span>}
      table={{
        columns: ['Server', 'Calls', 'Error rate'],
        rows: items.map((i) => [named(i), i.calls, `${(i.errorRate * 100).toFixed(1)}%`]),
      }}
    >
      <QueryBoundary query={totals} skeleton={<Skeleton className="h-[320px] w-full" />}>
        {() => (
          <ul className="m-0 grid list-none auto-rows-[64px] grid-cols-6 gap-1.5 p-0">
            {items.map((i) => {
              const tone = healthTone(i.errorRate);
              const s = span(i.calls);
              return (
                <li key={i.group} style={{ gridColumn: `span ${s.c}`, gridRow: `span ${s.r}` }}>
                  <Link
                    to={`/servers/${i.group}`}
                    title={`${named(i)}: ${formatNumber(i.calls)} calls, ${(i.errorRate * 100).toFixed(1)}% errors`}
                    className={cn(
                      'flex h-full flex-col justify-between overflow-hidden rounded-md p-2.5 text-on-bright no-underline hover:text-on-bright',
                      tone === 'ok' && 'bg-mint-soft text-mint-ink hover:text-mint-ink',
                      tone === 'warn' && 'bg-sun',
                      tone === 'bad' && 'bg-coral',
                    )}
                  >
                    <span className="truncate text-body-sm leading-[18px] font-semibold">
                      {named(i)}
                    </span>
                    <StatusDot
                      tone={tone}
                      label={HEALTH_LABEL[tone]}
                      className="!text-inherit [&>span:first-child]:hidden"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

const OrgOnly = ({ title }: { title: string }) => (
  <ChartCard title={title} table={{ columns: [], rows: [] }}>
    <p className="m-0 py-10 text-center text-muted">
      This view reads the org-wide rollups; admins and auditors see it.
    </p>
  </ChartCard>
);

// --- Latency band ---------------------------------------------------------------------------------------
export function LatencyPanel({ args, enabled = true }: { args: Args; enabled?: boolean }) {
  const q = useLatency(args, enabled);
  const data = q.data ?? [];
  const fmt = axisLabel(args.range);
  if (!enabled) return <OrgOnly title="Latency" />;
  return (
    <ChartCard
      title="Latency"
      legend={
        <Legend
          items={[
            { label: 'Typical (p50)', color: 'var(--tangerine)', shape: 'line' },
            { label: 'Slow (p95)', color: 'var(--coral)', shape: 'line' },
            { label: 'Slowest (p99)', color: 'var(--berry)', shape: 'line' },
          ]}
        />
      }
      table={{
        columns: ['Time', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Calls'],
        rows: data.map((b) => [fmt(b.t), b.p50, b.p95, b.p99, b.count]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[200px] w-full" />}>
        {() => (
          <AutoSize height={200}>
            <ComposedChart
              data={data}
              margin={{ top: 14, right: 4, left: 0, bottom: 0 }}
              accessibilityLayer={false}
            >
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="t"
                tickFormatter={fmt}
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis hide />
              <Tooltip
                content={
                  <ChartTooltip labelFormat={fmt} format={(v) => formatDuration(Number(v))} />
                }
              />
              {/* Slowest first, so the typical line is drawn on top. A single point (one call) has no line: it gets a dot. */}
              <Line
                type="monotone"
                dataKey="p99"
                name="p99"
                stroke="var(--berry)"
                strokeWidth={1.5}
                strokeDasharray="2 3"
                dot={data.length === 1}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                name="p95"
                stroke="var(--coral)"
                strokeWidth={1.75}
                strokeDasharray="5 3"
                dot={data.length === 1}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="p50"
                stroke="var(--tangerine)"
                strokeWidth={2.5}
                dot={data.length === 1}
                isAnimationActive={false}
              />
            </ComposedChart>
          </AutoSize>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Sandboxes ---------------------------------------------------------------------------------------------
export function SandboxPanel({ args, enabled = true }: { args: Args; enabled?: boolean }) {
  const q = useSandboxStats(args, enabled);
  const fmt = axisLabel(args.range);
  const d = q.data;
  if (!enabled) return <OrgOnly title="Sandboxes" />;
  return (
    <ChartCard
      title="Sandboxes"
      legend={
        d ? (
          <>
            {d.drivers.map((driver) => (
              <Tag key={driver} tone="info" className="h-6 text-[12px]">
                {driver}
              </Tag>
            ))}
            <Legend
              items={[
                { label: 'Starts', color: 'var(--sky)', shape: 'bar' },
                { label: 'Failed starts', color: 'var(--coral)', shape: 'bar' },
              ]}
            />
          </>
        ) : undefined
      }
      table={{
        columns: ['Time', 'Starts', 'Failed starts'],
        rows: (d?.slots ?? []).map((r) => [fmt(r.t), r.starts, r.failures]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[240px] w-full" />}>
        {(s) => (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-caption text-muted">
              {formatNumber(s.starts)} sandbox starts, {formatNumber(s.failures)} failed.
            </p>
            <AutoSize height={150}>
              <BarChart
                data={s.slots}
                margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
                accessibilityLayer={false}
              >
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="t"
                  tickFormatter={fmt}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={30}
                />
                <YAxis hide />
                <Tooltip content={<ChartTooltip labelFormat={fmt} />} />
                <Bar
                  dataKey="starts"
                  name="Starts"
                  stackId="s"
                  fill="var(--sky)"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="failures"
                  name="Failed starts"
                  stackId="s"
                  fill="var(--coral)"
                  isAnimationActive={false}
                />
              </BarChart>
            </AutoSize>
          </div>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Running sandboxes ------------------------------------------------------------------------------------
const SANDBOX_STATE = {
  starting: { tone: 'info', label: 'Starting' },
  running: { tone: 'ok', label: 'Running' },
  stopping: { tone: 'warn', label: 'Stopping' },
  failed: { tone: 'bad', label: 'Failed' },
} as const;

/** Every sandbox and remote connection the platform holds now, so "is anything running?" has an answer. */
export function RunningSandboxesPanel({ enabled = true }: { enabled?: boolean }) {
  const q = useSandboxes(enabled);
  if (!enabled) return null;
  return (
    <Card aria-label="Running sandboxes" className="gap-3 lg:col-span-2">
      <CardHeader
        title="Running sandboxes"
        subtitle="What is running now, for which server. Updates every few seconds."
      />
      <QueryBoundary
        query={q}
        skeleton={<Skeleton className="h-[120px] w-full" />}
        isEmpty={(d) => d.length === 0}
        empty={
          <p className="m-0 text-muted">Nothing is running. Servers start on their first call.</p>
        }
      >
        {(rows) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left text-body-sm">
              <thead>
                <tr className="text-caption text-muted">
                  <th className="py-1.5 pr-3 font-medium">Server</th>
                  <th className="py-1.5 pr-3 font-medium">State</th>
                  <th className="py-1.5 pr-3 font-medium">Kind</th>
                  <th className="py-1.5 pr-3 font-medium">Started</th>
                  <th className="py-1.5 font-medium">Last call</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = SANDBOX_STATE[r.state as keyof typeof SANDBOX_STATE];
                  return (
                    <tr key={r.id} className="border-t border-line">
                      <td className="py-2 pr-3">
                        {r.installationId ? (
                          <Link
                            to="/servers/$id"
                            params={{ id: r.installationId }}
                            className="font-medium underline"
                          >
                            {r.serverName ?? 'Unknown server'}
                          </Link>
                        ) : (
                          (r.serverName ?? 'Unknown server')
                        )}
                        {r.userName ? <span className="text-muted"> · {r.userName}</span> : null}
                      </td>
                      <td className="py-2 pr-3">
                        <Tag tone={st?.tone ?? 'info'}>{st?.label ?? r.state}</Tag>
                      </td>
                      <td className="py-2 pr-3 text-muted">
                        {r.kind === 'sandbox' ? (r.driver ?? 'sandbox') : 'Remote connection'}
                      </td>
                      <td className="py-2 pr-3 text-muted">
                        {r.startedAt ? formatRelative(r.startedAt) : 'Not yet'}
                      </td>
                      <td className="py-2 text-muted">
                        {r.lastUsedAt ? formatRelative(r.lastUsedAt) : 'Never'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}

import { Link } from '@tanstack/react-router';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { type StatsScope, useCallTotals, useLatency, useNames, useSandboxStats } from '@/api/hooks';
import type { GroupTotal, StatsRange } from '@/api/views/observability';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dateLabel, GRID, hourLabel } from '@/components/charts';
import { Legend, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { HEALTH_LABEL, healthTone, StatusDot } from '@/components/status';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatDuration, formatNumber } from '@/lib/format';

type Args = { range: StatsRange } & StatsScope;
const axisLabel = (range: StatsRange) =>
  range === '7d' || range === '14d' || range === '90d' ? dateLabel : hourLabel;

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
      legend={
        <Legend
          items={[
            { label: 'Succeeded', color: 'var(--sky)', shape: 'bar' },
            { label: 'Errors', color: 'var(--coral)', shape: 'bar' },
          ]}
        />
      }
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
                  className="truncate text-[13px] font-medium no-underline"
                >
                  {named(t)}
                </Link>
                <span className="flex h-4 overflow-hidden rounded-sm bg-sunken" aria-hidden="true">
                  <span
                    className="block h-full"
                    style={{
                      width: `${((t.calls - t.errors) / max) * 100}%`,
                      background: 'var(--sky)',
                    }}
                  />
                  <span
                    className="block h-full"
                    style={{ width: `${(t.errors / max) * 100}%`, background: 'var(--coral)' }}
                  />
                </span>
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
                    <span className="truncate text-[13px] leading-[18px] font-semibold">
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
  const data = (q.data ?? []).map((b) => ({ ...b, band: [b.p50, b.p95] as [number, number] }));
  const fmt = axisLabel(args.range);
  if (!enabled) return <OrgOnly title="Latency" />;
  return (
    <ChartCard
      title="Latency"
      legend={
        <Legend
          items={[
            { label: 'Typical (p50)', color: 'var(--tangerine)', shape: 'line' },
            { label: 'Slow tail (to p95)', color: 'var(--tangerine-soft)', shape: 'bar' },
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
              <Area
                dataKey="band"
                name="p50 to p95"
                stroke="none"
                fill="var(--tangerine-soft)"
                fillOpacity={1}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="p50"
                stroke="var(--tangerine)"
                strokeWidth={2.5}
                dot={false}
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

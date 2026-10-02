import { Link } from '@tanstack/react-router';
import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  Rectangle,
  ReferenceDot,
  Sankey,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { useFlowStats, useLatency, useSandboxStats } from '@/api/hooks';
import type { FlowStats, SandboxPhase, StatsRange, StatsScope } from '@/api/types';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dateLabel, GRID, hourLabel } from '@/components/charts';
import { Legend, Segmented, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { HEALTH_LABEL, healthTone, StatusDot } from '@/components/status';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatDuration, formatNumber } from '@/lib/format';
import { PHASE_COLOR } from '../activity/call-detail';

const Topology = React.lazy(() => import('./topology'));

type Args = { range: StatsRange } & StatsScope;
const axisLabel = (range: StatsRange) =>
  range === '7d' || range === '14d' || range === '90d' ? dateLabel : hourLabel;

// --- Traffic flow (Sankey) -------------------------------------------------------------------------
type SankeyNode = { name: string; errorRate?: number };

export const buildSankey = (flow: FlowStats) => {
  const nodes: SankeyNode[] = [
    ...flow.clients.map((name) => ({ name })),
    ...flow.installations.map((i) => ({ name: i.name, errorRate: i.errorRate })),
  ];
  const links = flow.links
    .map((l) => {
      const source = flow.clients.indexOf(l.client);
      const t = flow.installations.findIndex((i) => i.id === l.installationId);
      return { source, target: flow.clients.length + t, value: l.calls, errors: l.errors };
    })
    .filter((l) => l.source >= 0 && l.target >= flow.clients.length);
  return { nodes, links };
};

type NodeProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: SankeyNode & { sourceLinks?: unknown[] };
};
const makeNodeShape = (clientCount: number) =>
  function SankeyNodeShape({ x, y, width, height, index, payload }: NodeProps) {
    const isTarget = index >= clientCount;
    const bad = (payload.errorRate ?? 0) > 0.1;
    return (
      <g>
        <Rectangle
          x={x}
          y={y}
          width={width}
          height={height}
          fill={isTarget ? (bad ? 'var(--coral)' : 'var(--sky)') : 'var(--ink)'}
          fillOpacity={1}
        />
        <text
          x={isTarget ? x + width + 8 : x - 8}
          y={y + height / 2}
          textAnchor={isTarget ? 'start' : 'end'}
          dominantBaseline="middle"
          fontSize={12}
          fill="var(--ink)"
        >
          {payload.name}
        </text>
      </g>
    );
  };

type LinkProps = {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  payload: { target: SankeyNode };
};
function SankeyLinkShape({
  sourceX,
  targetX,
  sourceY,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
  payload,
}: LinkProps) {
  const bad = (payload.target.errorRate ?? 0) > 0.1;
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={bad ? 'var(--coral)' : 'var(--sky)'}
      strokeOpacity={0.38}
      strokeWidth={Math.max(1, linkWidth)}
    />
  );
}

export function TrafficPanel({ args }: { args: Args }) {
  const q = useFlowStats(args);
  const [view, setView] = React.useState<'flow' | 'topology'>('flow');
  const flow = q.data;
  const data = React.useMemo(() => (flow ? buildSankey(flow) : null), [flow]);
  return (
    <ChartCard
      title="Where calls go"
      legend={
        <>
          <Legend
            items={[
              { label: 'Healthy', color: 'var(--sky)', shape: 'line' },
              { label: 'Errors', color: 'var(--coral)', shape: 'line' },
            ]}
          />
          <Segmented
            label="Traffic view"
            value={view}
            onChange={setView}
            options={[
              { value: 'flow', label: 'Flow' },
              { value: 'topology', label: 'Topology' },
            ]}
          />
        </>
      }
      table={{
        columns: ['Client', 'Server', 'Calls', 'Errors'],
        rows: (flow?.links ?? []).map((l) => [
          l.client,
          flow?.installations.find((i) => i.id === l.installationId)?.name ?? l.installationId,
          l.calls,
          l.errors,
        ]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[320px] w-full" />}>
        {(f) =>
          view === 'topology' ? (
            <React.Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
              <Topology flow={f} />
            </React.Suspense>
          ) : data ? (
            <AutoSize height={320}>
              <Sankey
                data={data}
                nodePadding={14}
                nodeWidth={10}
                margin={{ top: 10, right: 130, bottom: 10, left: 100 }}
                node={makeNodeShape(f.clients.length) as never}
                link={SankeyLinkShape as never}
              >
                <Tooltip content={<ChartTooltip />} />
              </Sankey>
            </AutoSize>
          ) : null
        }
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Server health map -----------------------------------------------------------------------------------
export function HealthPanel({ args }: { args: Args }) {
  const q = useFlowStats(args);
  const items = [...(q.data?.installations ?? [])].sort((a, b) => b.calls - a.calls);
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
        rows: items.map((i) => [i.name, i.calls, `${(i.errorRate * 100).toFixed(1)}%`]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[320px] w-full" />}>
        {() => (
          <ul className="m-0 grid list-none auto-rows-[64px] grid-cols-6 gap-1.5 p-0">
            {items.map((i) => {
              const tone = healthTone(i.errorRate);
              const s = span(i.calls);
              return (
                <li key={i.id} style={{ gridColumn: `span ${s.c}`, gridRow: `span ${s.r}` }}>
                  <Link
                    to={`/servers/${i.id}`}
                    title={`${i.name}: ${formatNumber(i.calls)} calls, ${(i.errorRate * 100).toFixed(1)}% errors`}
                    className={cn(
                      'flex h-full flex-col justify-between overflow-hidden rounded-md p-2.5 text-on-bright no-underline hover:text-on-bright',
                      tone === 'ok' && 'bg-mint-soft text-mint-ink hover:text-mint-ink',
                      tone === 'warn' && 'bg-sun',
                      tone === 'bad' && 'bg-coral',
                    )}
                  >
                    <span className="truncate text-[13px] leading-[18px] font-semibold">
                      {i.name}
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

// --- Latency band ---------------------------------------------------------------------------------------
export function LatencyPanel({ args }: { args: Args }) {
  const q = useLatency(args);
  const data = (q.data ?? []).map((b) => ({ ...b, band: [b.p50, b.p95] as [number, number] }));
  const fmt = axisLabel(args.range);
  return (
    <ChartCard
      title="Latency"
      legend={
        <Legend
          items={[
            { label: 'Typical (p50)', color: 'var(--tangerine)', shape: 'line' },
            { label: 'Slow tail (to p95)', color: 'var(--tangerine-soft)', shape: 'bar' },
            { label: 'Cold start', color: 'var(--sky)', shape: 'triangle' },
          ]}
        />
      }
      table={{
        columns: ['Time', 'p50 (ms)', 'p95 (ms)', 'Cold start'],
        rows: data.map((b) => [fmt(b.t), b.p50, b.p95, b.coldStart ? 'yes' : '']),
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
              {data
                .filter((b) => b.coldStart)
                .map((b) => (
                  <ReferenceDot key={b.t} x={b.t} y={b.p95} r={5} fill="var(--sky)" stroke="none" />
                ))}
            </ComposedChart>
          </AutoSize>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

// --- Sandboxes ---------------------------------------------------------------------------------------------
const PHASES: SandboxPhase[] = ['claim', 'bind', 'install', 'spawn', 'connect'];

export function SandboxPanel({ args }: { args: Args }) {
  const q = useSandboxStats(args);
  const fmt = axisLabel(args.range);
  const d = q.data;
  return (
    <ChartCard
      title="Sandboxes"
      legend={
        d ? (
          <Tag tone="info" className="h-6 text-[12px]">
            {d.driver}
          </Tag>
        ) : undefined
      }
      table={{
        columns: ['Time', 'Running sandboxes'],
        rows: (d?.running ?? []).map((r) => [fmt(r.t), r.count]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[240px] w-full" />}>
        {(s) => (
          <div className="flex flex-col gap-3">
            <AutoSize height={110}>
              <AreaChart
                data={s.running}
                margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
                accessibilityLayer={false}
              >
                <defs>
                  <linearGradient id="sbArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--sky)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--sky)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" hide />
                <YAxis hide />
                <Tooltip content={<ChartTooltip labelFormat={fmt} />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="Running"
                  stroke="var(--sky)"
                  strokeWidth={2.5}
                  fill="url(#sbArea)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </AutoSize>
            <span className="text-caption text-muted">Start time by phase</span>
            <AutoSize height={120}>
              <ScatterChart
                margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
                accessibilityLayer={false}
              >
                <XAxis
                  type="number"
                  dataKey="ms"
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatDuration(Number(v))}
                />
                <YAxis
                  type="category"
                  dataKey="phase"
                  width={64}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  allowDuplicatedCategory={false}
                  interval={0}
                />
                <ZAxis range={[40, 40]} />
                <Tooltip content={<ChartTooltip format={(v) => formatDuration(Number(v))} />} />
                {PHASES.map((p) => (
                  <Scatter
                    key={p}
                    name={p}
                    data={s.starts.filter((x) => x.phase === p)}
                    fill={PHASE_COLOR[p]}
                    fillOpacity={0.75}
                    isAnimationActive={false}
                  />
                ))}
              </ScatterChart>
            </AutoSize>
          </div>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

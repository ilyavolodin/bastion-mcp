import { Eye, EyeOff, Pencil, ShieldCheck } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceDot, Tooltip, XAxis, YAxis } from 'recharts';
import { useCalls, useCallSeries, useCapabilities } from '@/api/hooks';
import type { EffectiveCapability, Installation } from '@/api/types';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, GRID, hourLabel } from '@/components/charts';
import { CopyField } from '@/components/copy-field';
import { Card, CardHeader, Legend } from '@/components/primitives';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { formatClock } from '@/lib/format';
import { PHASE_COLOR } from '@/features/activity/call-detail';

export function CapabilityMarkers({ c }: { c: EffectiveCapability }) {
  return (
    <span className="flex gap-1.5">
      {c.overridden ? <Pencil className="size-4 text-tangerine-ink" strokeWidth={2} aria-label="Overridden" role="img" /> : null}
      {c.hidden ? <EyeOff className="size-4 text-muted" strokeWidth={2} aria-label="Hidden" role="img" /> : null}
      {c.guarded ? <ShieldCheck className="size-4 text-sky-ink" strokeWidth={2} aria-label="Guarded" role="img" /> : null}
    </span>
  );
}

const KIND_LETTER = { tool: 'T', prompt: 'P', resource: 'R', template: 'U' } as const;

export function CapabilityRow({ c }: { c: EffectiveCapability }) {
  return (
    <li className={`flex min-h-[52px] items-center gap-3 border-b border-line ${c.hidden ? 'opacity-60' : ''}`}>
      <span title={c.kind} className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-sunken text-[10px] font-semibold text-muted">
        {KIND_LETTER[c.kind]}
        <span className="sr-only"> {c.kind}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[13px] leading-5 font-semibold">{c.finalName}</div>
        <div className="truncate text-caption text-muted">{c.hidden ? 'Hidden from your AI tools' : c.description}</div>
      </div>
      <CapabilityMarkers c={c} />
    </li>
  );
}

export function CapabilityLegend() {
  return (
    <>
      <span className="inline-flex items-center gap-1 text-caption text-muted">
        <Pencil className="size-3.5 text-tangerine-ink" aria-hidden="true" />
        Overridden
      </span>
      <span className="inline-flex items-center gap-1 text-caption text-muted">
        <EyeOff className="size-3.5" aria-hidden="true" />
        Hidden
      </span>
      <span className="inline-flex items-center gap-1 text-caption text-muted">
        <ShieldCheck className="size-3.5 text-sky-ink" aria-hidden="true" />
        Guarded
      </span>
    </>
  );
}

export function OverviewTab({ installation, goTo }: { installation: Installation; goTo: (tab: string) => void }) {
  const series = useCallSeries({ range: '24h', installationId: installation.id });
  const caps = useCapabilities(installation.id);
  const errs = useCalls({ installationId: installation.id });
  const buckets = series.data?.buckets ?? [];
  const failed = (errs.data?.pages.flatMap((p) => p.items) ?? []).filter((c) => c.outcome !== 'ok').slice(0, 3);
  const sandboxed = installation.runtime !== 'remote';
  const cold = buckets.filter((b) => b.coldStarts > 0);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <ChartCard
          title="Last 24 hours"
          legend={
            <>
              <Legend
                items={[
                  { label: 'Calls', color: 'var(--tangerine)', shape: 'line' },
                  { label: 'Errors', color: 'var(--coral)', shape: 'bar' },
                  { label: 'Cold start', color: 'var(--sky)', shape: 'triangle' },
                ]}
              />
            </>
          }
          table={{
            columns: ['Hour', 'Calls', 'Errors', 'Cold starts'],
            rows: buckets.map((b) => [hourLabel(b.t), b.calls, b.errors, b.coldStarts]),
          }}
        >
          {series.isPending ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <AutoSize height={200}>
              <ComposedChart data={buckets} margin={{ top: 14, right: 4, left: 0, bottom: 0 }} accessibilityLayer={false}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="t" tickFormatter={hourLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} interval={5} />
                <YAxis hide />
                <Tooltip content={<ChartTooltip labelFormat={hourLabel} />} />
                <Bar dataKey="errors" name="Errors" fill="var(--coral)" radius={[2, 2, 0, 0]} barSize={10} />
                <Line type="monotone" dataKey="calls" name="Calls" stroke="var(--tangerine)" strokeWidth={2.5} dot={false} />
                {cold.map((b) => (
                  <ReferenceDot key={b.t} x={b.t} y={b.calls} r={5} fill="var(--sky)" stroke="none" ifOverflow="visible" />
                ))}
              </ComposedChart>
            </AutoSize>
          )}
        </ChartCard>

        <Card aria-label="Capabilities" className="gap-1">
          <CardHeader
            title="What your AI tools see"
            className="mb-2"
            actions={
              <>
                <CapabilityLegend />
                <Button variant="ghost" size="xs" onClick={() => goTo('capabilities')}>
                  See all
                </Button>
              </>
            }
          />
          {caps.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <ul className="m-0 list-none p-0">
              {(caps.data ?? []).slice(0, 6).map((c) => (
                <CapabilityRow key={`${c.kind}-${c.name}`} c={c} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {sandboxed ? (
          <Card aria-label="Sandbox" className="gap-3.5">
            <CardHeader title="Sandbox" />
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-mint ring-4 ring-mint-soft" aria-hidden="true" />
              <span className="text-label">
                {installation.status === 'ready' ? 'Warm · idles out in 11 min' : 'Not running'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-muted">Last cold start</span>
              <div className="flex h-3.5 gap-0.5 overflow-hidden rounded-sm" role="img" aria-label="Cold start phases: claim, bind, install, spawn, connect">
                {[['claim', 2], ['bind', 1], ['install', 5], ['spawn', 3], ['connect', 2]].map(([n, f]) => (
                  <span key={n} title={String(n)} style={{ flex: Number(f), background: PHASE_COLOR[String(n)] }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-2.5 text-[11px] text-muted">
                {['claim', 'bind', 'install', 'spawn', 'connect'].map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            </div>
          </Card>
        ) : null}

        <Card aria-label="Endpoint" className="gap-3">
          <CardHeader title="Use it on its own" />
          <CopyField value={installation.endpointUrl} label="installation endpoint URL" tone="sunken" />
          <p className="m-0 text-caption text-muted">Tool names stay unprefixed on this URL.</p>
        </Card>

        <Card aria-label="Latest errors" className="gap-2.5">
          <CardHeader title="Latest errors" />
          {errs.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : failed.length === 0 ? (
            <p className="m-0 flex items-center gap-2 text-muted">
              <Eye className="size-4" aria-hidden="true" />
              No errors lately.
            </p>
          ) : (
            failed.map((c) => (
              <div key={c.id} className="flex items-start gap-2.5">
                <span className="mt-[7px] size-2 shrink-0 rounded-full bg-coral" aria-hidden="true" />
                <div>
                  <div className="text-[13px] leading-5 font-medium">
                    {c.outcome === 'blocked' ? 'Blocked by guard' : c.outcome === 'denied' ? 'Denied by policy' : 'Upstream error'}: {c.item}
                  </div>
                  <div className="text-caption text-muted">{formatClock(c.startedAt)} · {c.client}</div>
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

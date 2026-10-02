import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis } from 'recharts';
import { toast } from 'sonner';
import { z } from 'zod';
import { useDecideDrift, useDriftReviews, useFindings, useGuardStats } from '@/api/hooks';
import type { DriftReview, GuardKind, StatsRange } from '@/api/types';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dateLabel, GRID, hourLabel } from '@/components/charts';
import { DiffView } from '@/components/diff-view';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import {
  Card,
  CardHeader,
  Legend,
  Overline,
  ReadOnlyNote,
  Segmented,
  ServerIcon,
  Tag,
} from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { FindingBlock } from '../activity/call-detail';

export const GUARD_META: Record<GuardKind, { label: string; color: string }> = {
  prompt_injection: { label: 'Prompt injection', color: 'var(--berry)' },
  pii: { label: 'PII', color: 'var(--sky)' },
  regex: { label: 'Regex rules', color: 'var(--tangerine)' },
  definition_drift: { label: 'Definition drift', color: 'var(--teal)' },
};
const KINDS = Object.keys(GUARD_META) as GuardKind[];

const searchSchema = z.object({
  range: z.enum(['24h', '14d', '90d']).catch('14d').default('14d'),
  review: z.coerce.string().optional(),
});

function FindingsChart({ range }: { range: StatsRange }) {
  const q = useGuardStats({ range });
  const fmt = range === '24h' ? hourLabel : dateLabel;
  const rows = (q.data?.buckets ?? []).map((b) => ({ t: b.t, ...b.counts }));
  return (
    <ChartCard
      title="Findings by guard"
      legend={
        <Legend
          items={KINDS.map((k) => ({ label: GUARD_META[k].label, color: GUARD_META[k].color }))}
        />
      }
      table={{
        columns: ['Day', ...KINDS.map((k) => GUARD_META[k].label)],
        rows: rows.map((r) => [fmt(r.t), ...KINDS.map((k) => r[k])]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[220px] w-full" />}>
        {() => (
          <AutoSize height={220}>
            <BarChart
              data={rows}
              margin={{ top: 8, right: 0, left: 0, bottom: 0 }}
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
              <Tooltip
                content={<ChartTooltip labelFormat={fmt} />}
                cursor={{ fill: 'var(--surface-sunken)' }}
              />
              {KINDS.map((k) => (
                <Bar
                  key={k}
                  dataKey={k}
                  name={GUARD_META[k].label}
                  stackId="g"
                  fill={GUARD_META[k].color}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </AutoSize>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

function Ranked({
  title,
  items,
  color,
  mono,
}: {
  title: string;
  items: { name: string; count: number }[];
  color: string;
  mono?: boolean;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex flex-col gap-2.5">
      <Overline>{title}</Overline>
      {items.map((t) => (
        <div
          key={t.name}
          className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2.5"
          title={`${t.name}: ${t.count} findings`}
        >
          <span
            className={cn('truncate font-medium', mono ? 'font-mono text-[12px]' : 'text-[13px]')}
          >
            {t.name}
          </span>
          <span className="h-3.5 overflow-hidden rounded-sm bg-sunken">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(t.count / max) * 100}%`, background: color }}
            />
          </span>
          <span className="sr-only">{t.count} findings</span>
        </div>
      ))}
    </div>
  );
}

function TopFlagged({ range }: { range: StatsRange }) {
  const q = useGuardStats({ range });
  return (
    <ChartCard
      title="Most flagged"
      table={{
        columns: ['Name', 'Kind', 'Findings'],
        rows: [
          ...(q.data?.topServers ?? []).map((s) => [s.name, 'Server', s.count]),
          ...(q.data?.topTools ?? []).map((s) => [s.name, 'Tool', s.count]),
        ],
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[220px] w-full" />}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <Ranked title="Servers" items={d.topServers} color="var(--tangerine)" />
            <Ranked title="Tools" items={d.topTools} color="var(--sky)" mono />
          </div>
        )}
      </QueryBoundary>
    </ChartCard>
  );
}

const RISK = {
  high: { tone: 'bad', label: 'High' },
  medium: { tone: 'warn', label: 'Medium' },
  low: { tone: 'ok', label: 'Low' },
} as const;

function ReviewDetail({ r }: { r: DriftReview }) {
  const decide = useDecideDrift();
  const act = (decision: 'approve' | 'reject') =>
    decide.mutate(
      { id: r.id, decision },
      {
        onSuccess: () =>
          toast.success(
            decision === 'approve'
              ? 'New definition accepted'
              : `Still blocking ${r.upstreamVersion}`,
          ),
      },
    );
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <DiffView
        leftLabel={`Approved · ${r.approvedVersion}`}
        rightLabel={`Upstream now · ${r.upstreamVersion}`}
        left={r.approved}
        right={r.upstream}
      />
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-md px-3.5 py-3',
          r.scan.verdict === 'clean' ? 'bg-mint-soft' : 'bg-berry-soft',
        )}
      >
        {r.scan.verdict === 'clean' ? (
          <ShieldCheck className="size-[18px] text-mint-ink" aria-hidden="true" />
        ) : (
          <ShieldAlert className="size-[18px] text-berry-ink" aria-hidden="true" />
        )}
        <span className="flex-1 text-[13px] leading-5">
          <strong className="font-semibold">Description scan:</strong> {r.scan.message}
        </span>
      </div>
      {r.canDecide ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="danger" disabled={decide.isPending} onClick={() => act('reject')}>
            Keep blocking {r.upstreamVersion}
          </Button>
          <Button
            variant="outline"
            disabled={decide.isPending || r.scan.verdict === 'malicious'}
            onClick={() => act('approve')}
          >
            Accept new definition
          </Button>
          {r.scan.verdict === 'malicious' ? (
            <span className="text-caption text-muted">
              A malicious scan needs an Admin override with a reason.
            </span>
          ) : null}
        </div>
      ) : (
        <ReadOnlyNote>Read-only. A Manager of the owning team or an Admin decides.</ReadOnlyNote>
      )}
    </div>
  );
}

function DriftQueue() {
  const q = useDriftReviews('open');
  const [s, setS] = useSearchState(searchSchema);
  const items = q.data ?? [];
  const current = items.find((r) => r.id === s.review) ?? items[0];
  return (
    <Card aria-label="Drift reviews" className="gap-4">
      <CardHeader
        title="Changed tool definitions"
        subtitle="Calls to a changed tool stay on the approved definition until someone reviews it."
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<ShieldCheck />}
            title="No definitions are waiting"
            description="When a server changes a tool after approval, it shows up here with a diff."
          />
        }
      >
        {() => (
          <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
            <ul aria-label="Reviews" className="m-0 flex list-none flex-col gap-2 p-0">
              {items.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={r.id === current?.id}
                    onClick={() => setS({ review: r.id })}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md p-3 text-left',
                      r.id === current?.id ? 'bg-surface ring-2 ring-tangerine-ink' : 'bg-sunken',
                    )}
                  >
                    <ServerIcon letter={r.letter} color={r.color} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] leading-5 font-semibold">
                        {r.itemName}
                      </span>
                      <span className="block text-caption text-muted">
                        {r.serverName} · {formatRelative(r.createdAt)}
                      </span>
                    </span>
                    <Tag tone={RISK[r.risk].tone}>{RISK[r.risk].label}</Tag>
                  </button>
                </li>
              ))}
            </ul>
            {current ? <ReviewDetail r={current} /> : null}
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}

function RecentFindings({ range }: { range: StatsRange }) {
  const q = useFindings(range);
  return (
    <Card aria-label="Recent findings" className="gap-3">
      <CardHeader
        title="Recent findings"
        subtitle="The triggering segment is highlighted in context."
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={<p className="m-0 text-muted">No findings in this period.</p>}
      >
        {(items) => (
          <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
            {items.map((f) => (
              <li key={f.id} className="flex flex-col gap-1.5">
                <span className="text-caption text-muted">
                  {f.installationName} · <span className="font-mono">{f.tool}</span> ·{' '}
                  {formatRelative(f.createdAt)}
                </span>
                <FindingBlock finding={f} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

export function SecurityPage() {
  const [s, setS] = useSearchState(searchSchema);
  const range: StatsRange = s.range;
  return (
    <>
      <PageHeader
        title="Security"
        subtitle="What the guards caught, and tool definitions that changed since they were approved."
        actions={
          <Segmented
            label="Time range"
            value={s.range}
            onChange={(v) => setS({ range: v })}
            options={[
              { value: '24h', label: '24h' },
              { value: '14d', label: '14 days' },
              { value: '90d', label: '90 days' },
            ]}
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <FindingsChart range={range} />
        <TopFlagged range={range} />
      </div>
      <DriftQueue />
      <RecentFindings range={range} />
    </>
  );
}

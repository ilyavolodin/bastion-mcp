import { Activity as ActivityIcon } from 'lucide-react';
import { z } from 'zod';
import { useCalls, useCallSeries, useInstallations, useTeams, useUsers } from '@/api/hooks';
import type { CallBucket, CallFilters, CallOutcome, CallRecord } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { ChartCard } from '@/components/chart-card';
import { EmptyState } from '@/components/empty-state';
import { FilterSelect } from '@/components/filter-select';
import { Avatar, Legend } from '@/components/primitives';
import { OUTCOME, OutcomeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ProblemAlert } from '@/components/problem';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/cn';
import { formatClock, formatDate, formatDuration } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { CallDetailPanel } from './call-detail';

export const activitySearch = z.object({
  user: z.coerce.string().optional(),
  team: z.coerce.string().optional(),
  server: z.coerce.string().optional(),
  item: z.coerce.string().optional(),
  outcome: z.coerce.string().optional(),
  range: z.enum(['1h', '24h', '7d']).catch('24h').default('24h'),
  call: z.coerce.string().optional(),
});

const OUTCOME_OPTIONS = (Object.keys(OUTCOME) as CallOutcome[]).map((o) => ({ value: o, label: OUTCOME[o].label }));

const RANGE_LABEL = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' } as const;

/** Outcome-colored strip: each slot is a stack of that slot's outcomes, tallest = busiest. */
function TimelineStrip({ buckets, range }: { buckets: CallBucket[]; range: keyof typeof RANGE_LABEL }) {
  const max = Math.max(1, ...buckets.map((b) => b.calls));
  return (
    <div className="flex h-16 items-end gap-0.5" aria-hidden="true">
      {buckets.map((b) => {
        const parts: [number, string][] = [
          [b.ok, 'var(--mint)'],
          [b.upstreamError, 'var(--sun)'],
          [b.denied, 'var(--berry-ink)'],
          [b.blocked, 'var(--coral-ink)'],
        ];
        return (
          <div
            key={b.t}
            title={`${range === '7d' ? formatDate(b.t) : formatClock(b.t)}: ${b.calls} calls`}
            className="flex flex-1 flex-col-reverse gap-px"
            style={{ height: `${(b.calls / max) * 100}%` }}
          >
            {parts
              .filter(([n]) => n > 0)
              .map(([n, color]) => (
                <span key={color} className="min-h-[2px] rounded-[2px]" style={{ flex: n, background: color }} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function CallRow({
  call,
  selected,
  people,
  maxMs,
  onSelect,
}: {
  call: CallRecord;
  selected: boolean;
  people: boolean;
  maxMs: number;
  onSelect: () => void;
}) {
  const o = OUTCOME[call.outcome];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'grid min-h-14 w-full items-center gap-3 border-b border-line px-5 text-left',
          people
            ? 'grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_110px_150px]'
            : 'grid-cols-[72px_minmax(0,2fr)_110px_150px]',
          'max-lg:grid-cols-[64px_minmax(0,1fr)_auto]',
          call.outcome === 'blocked' && 'bg-coral-soft/50',
          selected && 'bg-tangerine-soft',
        )}
      >
        <span className="text-caption tabular-nums text-muted">{formatClock(call.startedAt, true).slice(0, 8)}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-[13px] leading-5 font-semibold">{call.item}</span>
          <span className="text-[11px] leading-4 text-muted">
            {call.method} · {call.client}
          </span>
        </span>
        {people ? (
          <span className="flex min-w-0 items-center gap-2 max-lg:hidden">
            <Avatar name={call.principalName} size={24} />
            <span className="truncate text-[13px]">{call.principalName}</span>
          </span>
        ) : null}
        <span className="flex items-center max-lg:hidden" title={formatDuration(call.durationMs)}>
          <span
            className={cn('h-2 rounded-[4px]', o.bar)}
            style={{ width: `${Math.max(6, (call.durationMs / maxMs) * 100)}%` }}
          />
          <span className="sr-only">{formatDuration(call.durationMs)}</span>
        </span>
        <OutcomeBadge outcome={call.outcome} />
      </button>
    </li>
  );
}

/**
 * Call explorer (18.3): filters, an outcome-colored strip, the call list and a trace drawer. Embedded
 * in an installation's Activity tab with the server filter fixed.
 */
export function CallExplorer({ fixedInstallationId }: { fixedInstallationId?: string }) {
  const { role } = useAuth();
  const [s, setS] = useSearchState(activitySearch);
  const wide = useMediaQuery('(min-width: 1280px)');
  const showPeople = role !== 'member';
  const users = useUsers({}, showPeople);
  const teams = useTeams(showPeople);
  const installs = useInstallations();

  const filters: CallFilters = {
    ...(s.user ? { userId: s.user } : {}),
    ...(s.team ? { teamId: s.team } : {}),
    ...(fixedInstallationId ? { installationId: fixedInstallationId } : s.server ? { installationId: s.server } : {}),
    ...(s.item ? { item: s.item } : {}),
    ...(s.outcome ? { outcome: s.outcome as CallOutcome } : {}),
    range: s.range,
  };
  const calls = useCalls(filters);
  const series = useCallSeries({
    range: s.range === '7d' ? '7d' : s.range === '1h' ? '1h' : '24h',
    ...(fixedInstallationId ? { installationId: fixedInstallationId } : {}),
  });
  const rows = calls.data?.pages.flatMap((p) => p.items) ?? [];
  const maxMs = Math.max(1, ...rows.map((r) => r.durationMs));
  const buckets = series.data?.buckets ?? [];
  const closeCall = () => setS({ call: undefined });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        {showPeople && !fixedInstallationId ? (
          <>
            <FilterSelect label="Person" value={s.user ?? ''} onChange={(v) => setS({ user: v || undefined })} options={(users.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
            <FilterSelect label="Team" value={s.team ?? ''} onChange={(v) => setS({ team: v || undefined })} options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </>
        ) : null}
        {!fixedInstallationId ? (
          <FilterSelect label="Server" value={s.server ?? ''} onChange={(v) => setS({ server: v || undefined })} options={(installs.data ?? []).map((i) => ({ value: i.id, label: i.displayName }))} />
        ) : null}
        <label className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-3.5 text-[13px] font-medium">
          <span className="sr-only">Tool</span>
          <input
            type="search"
            placeholder="Tool: any"
            aria-label="Tool"
            value={s.item ?? ''}
            onChange={(e) => setS({ item: e.target.value || undefined })}
            className="w-28 bg-transparent text-[13px] outline-none placeholder:text-ink"
          />
        </label>
        <FilterSelect label="Outcome" value={s.outcome ?? ''} onChange={(v) => setS({ outcome: v || undefined })} options={OUTCOME_OPTIONS} />
        <FilterSelect
          label="Time range"
          value={s.range}
          anyLabel={null}
          onChange={(v) => setS({ range: v as '1h' | '24h' | '7d' })}
          options={(Object.keys(RANGE_LABEL) as (keyof typeof RANGE_LABEL)[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
        />
      </div>

      <ChartCard
        title="Calls over time"
        className="gap-2.5 px-5 py-4"
        legend={
          <Legend
            items={[
              { label: 'Succeeded', color: 'var(--mint)' },
              { label: 'Upstream error', color: 'var(--sun)' },
              { label: 'Denied by policy', color: 'var(--berry-ink)' },
              { label: 'Blocked by guard', color: 'var(--coral-ink)' },
            ]}
          />
        }
        table={{
          columns: ['Time', 'Calls', 'Succeeded', 'Upstream error', 'Denied', 'Blocked'],
          rows: buckets.map((b) => [s.range === '7d' ? formatDate(b.t) : formatClock(b.t), b.calls, b.ok, b.upstreamError, b.denied, b.blocked]),
        }}
      >
        {series.isPending ? <Skeleton className="h-16 w-full" /> : <TimelineStrip buckets={buckets} range={s.range} />}
      </ChartCard>

      <div className="flex items-start gap-6">
        <section aria-label="Calls" className="min-w-0 flex-1 overflow-hidden rounded-lg bg-surface pb-3 shadow-card">
          <div
            className={cn(
              'grid h-11 items-center gap-3 border-b border-line px-5 text-overline',
              showPeople ? 'grid-cols-[72px_minmax(0,1.6fr)_minmax(0,1fr)_110px_150px]' : 'grid-cols-[72px_minmax(0,2fr)_110px_150px]',
              'max-lg:hidden',
            )}
            aria-hidden="true"
          >
            <span>Time</span>
            <span>Call</span>
            {showPeople ? <span>Person</span> : null}
            <span>Duration</span>
            <span>Outcome</span>
          </div>
          {calls.isPending ? (
            <div role="status" aria-label="Loading calls" className="flex flex-col gap-2 p-5">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : calls.isError ? (
            <div className="p-5">
              <ProblemAlert error={calls.error} onRetry={() => void calls.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ActivityIcon />}
              title="No calls match"
              description="Widen the time range or clear a filter to see more."
              action={{ label: 'Clear filters', onClick: () => setS({ user: undefined, team: undefined, server: undefined, item: undefined, outcome: undefined, range: '24h' }) }}
            />
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((c) => (
                <CallRow key={c.id} call={c} people={showPeople} maxMs={maxMs} selected={s.call === c.id} onSelect={() => setS({ call: c.id })} />
              ))}
            </ul>
          )}
          {calls.hasNextPage ? (
            <div className="flex justify-center pt-3">
              <Button variant="outline" size="sm" onClick={() => void calls.fetchNextPage()} disabled={calls.isFetchingNextPage}>
                {calls.isFetchingNextPage ? 'Loading…' : 'Load older calls'}
              </Button>
            </div>
          ) : null}
        </section>
        {s.call && wide ? <CallDetailPanel id={s.call} docked onClose={closeCall} /> : null}
      </div>
      {s.call && !wide ? (
        <Dialog open onOpenChange={(o) => !o && closeCall()}>
          <DialogContent title="Call detail" placement="drawer" hideTitle>
            <CallDetailPanel id={s.call} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}


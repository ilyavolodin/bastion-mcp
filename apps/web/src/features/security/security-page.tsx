import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis } from 'recharts';
import { toast } from 'sonner';
import { z } from 'zod';
import { useDecideDrift, useDriftReviews, useFindings, useGuardStats } from '@/api/hooks';
import {
  type DriftView,
  FINDING_KIND_LABEL,
  type GuardTotals,
  guardSlots,
  type StatsRange,
} from '@/api/views/observability';
import { useAuth } from '@/auth/auth';
import { ChartCard } from '@/components/chart-card';
import { AutoSize, AXIS_TICK, ChartTooltip, dateLabel, GRID, hourLabel } from '@/components/charts';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
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
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { letterOf, tintOf } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useSearchState } from '@/lib/search';
import { GuardResultBlock } from '../activity/call-detail';
import {
  type ApproveValues,
  approveSchema,
  type RejectValues,
  rejectSchema,
  toApproveBody,
  toRejectBody,
} from './forms';

const VERDICT_META = {
  suspicious: { label: 'Suspicious', color: 'var(--sun)' },
  malicious: { label: 'Malicious', color: 'var(--coral)' },
  error: { label: 'Guard errors', color: 'var(--berry)' },
} as const;
const VERDICTS = Object.keys(VERDICT_META) as (keyof typeof VERDICT_META)[];

const searchSchema = z.object({
  range: z.enum(['24h', '14d', '90d']).catch('14d').default('14d'),
  review: z.coerce.string().optional(),
});

function FindingsChart({ range }: { range: StatsRange }) {
  const q = useGuardStats({ range });
  const fmt = range === '24h' ? hourLabel : dateLabel;
  const rows = q.data ? guardSlots(q.data.stats) : [];
  return (
    <ChartCard
      title="Findings by guard"
      legend={
        <Legend
          items={VERDICTS.map((v) => ({
            label: VERDICT_META[v].label,
            color: VERDICT_META[v].color,
          }))}
        />
      }
      table={{
        columns: ['Day', ...VERDICTS.map((v) => VERDICT_META[v].label)],
        rows: rows.map((r) => [fmt(r.t), ...VERDICTS.map((v) => r[v])]),
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
              {VERDICTS.map((v) => (
                <Bar
                  key={v}
                  dataKey={v}
                  name={VERDICT_META[v].label}
                  stackId="g"
                  fill={VERDICT_META[v].color}
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

function Ranked({ items }: { items: GuardTotals[] }) {
  const max = Math.max(1, ...items.map((i) => i.flagged));
  return (
    <div className="flex flex-col gap-2.5">
      <Overline>Guards</Overline>
      {items.map((t) => (
        <div
          key={t.guard}
          className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2.5"
          title={`${t.guard}: ${t.flagged} findings`}
        >
          <span className="truncate font-mono text-[12px] font-medium">{t.guard}</span>
          <span className="h-3.5 overflow-hidden rounded-sm bg-sunken">
            <span
              className="block h-full rounded-sm"
              style={{ width: `${(t.flagged / max) * 100}%`, background: 'var(--tangerine)' }}
            />
          </span>
          <span className="sr-only">{t.flagged} findings</span>
        </div>
      ))}
    </div>
  );
}

function TopFlagged({ range }: { range: StatsRange }) {
  const q = useGuardStats({ range });
  const totals = (q.data?.totals ?? []).filter((t) => t.flagged > 0);
  return (
    <ChartCard
      title="Most flagged"
      table={{
        columns: ['Guard', 'Suspicious', 'Malicious', 'Errors', 'Clean'],
        rows: (q.data?.totals ?? []).map((t) => [
          t.guard,
          t.suspicious,
          t.malicious,
          t.error,
          t.clean,
        ]),
      }}
    >
      <QueryBoundary query={q} skeleton={<Skeleton className="h-[220px] w-full" />}>
        {() =>
          totals.length === 0 ? (
            <p className="m-0 text-muted">No guard flagged anything in this period.</p>
          ) : (
            <Ranked items={totals} />
          )
        }
      </QueryBoundary>
    </ChartCard>
  );
}

const RISK = {
  high: { tone: 'bad', label: 'High' },
  medium: { tone: 'warn', label: 'Medium' },
  low: { tone: 'ok', label: 'Low' },
} as const;

type Decision = 'approve' | 'reject';

function DecisionDialog({
  review,
  decision,
  onClose,
}: {
  review: DriftView;
  decision: Decision;
  onClose: () => void;
}) {
  const decide = useDecideDrift();
  const reject = decision === 'reject';
  const form = useForm<RejectValues & ApproveValues>({
    resolver: zodResolver(reject ? rejectSchema : approveSchema) as never,
    defaultValues: { reason: '', note: '' },
  });
  const [problem, setProblem] = React.useState<string | undefined>();
  const submit = form.handleSubmit((values) => {
    setProblem(undefined);
    const done = {
      onSuccess: () => {
        toast.success(reject ? `Still blocking ${review.itemKey}` : 'New definition accepted');
        onClose();
      },
      onError: (e: Error) => setProblem(e.message),
    };
    decide.mutate(
      reject
        ? { id: review.id, decision: 'reject', body: toRejectBody(values) }
        : { id: review.id, decision: 'approve', body: toApproveBody(values) },
      done,
    );
  });
  const error = form.formState.errors[reject ? 'reason' : 'note']?.message;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={reject ? `Keep blocking ${review.itemKey}` : `Accept ${review.itemKey}`}
        description={
          reject
            ? 'Calls stay on the approved definition. Say why, so the owner can see it.'
            : 'The new definition goes live for everyone who uses this server.'
        }
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field
            label={reject ? 'Reason' : 'Note'}
            required={reject}
            error={error}
            help={reject ? undefined : 'Optional. Recorded with the approval.'}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register(reject ? 'reason' : 'note')}
              />
            )}
          </Field>
          {problem ? (
            <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
              {problem}
            </p>
          ) : null}
          <Button type="submit" variant={reject ? 'danger' : 'primary'} disabled={decide.isPending}>
            {reject ? 'Keep blocking' : 'Accept definition'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDetail({ r }: { r: DriftView }) {
  const { role } = useAuth();
  const [deciding, setDeciding] = React.useState<Decision | null>(null);
  const canDecide = role === 'admin' || role === 'manager';
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <section
        aria-label="New definition"
        data-testid="definition-view"
        className="flex flex-col gap-2 rounded-md bg-sunken p-3.5"
      >
        <Overline>Upstream now</Overline>
        <div className="font-mono text-[13px] font-semibold">{r.itemKey}</div>
        <p className="m-0 text-[13px] leading-5">
          {r.description || 'This definition has no description.'}
        </p>
        <div
          role="region"
          aria-label="New definition"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
          tabIndex={0}
          className="overflow-x-auto"
        >
          <pre className="m-0 font-mono text-[12px] text-muted">
            {JSON.stringify(r.newDefinition, null, 2)}
          </pre>
        </div>
        <p className="m-0 text-caption text-muted">
          {r.oldHash ? 'Changed from' : 'New since the last approval'}{' '}
          {r.oldHash ? <span className="font-mono">{r.oldHash.slice(0, 10)}</span> : null}
          {r.oldHash ? ' to ' : ' · '}
          <span className="font-mono">{r.newHash.slice(0, 10)}</span>
        </p>
      </section>
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-md px-3.5 py-3',
          r.verdict === 'clean' ? 'bg-mint-soft' : 'bg-berry-soft',
        )}
      >
        {r.verdict === 'clean' ? (
          <ShieldCheck className="size-[18px] text-mint-ink" aria-hidden="true" />
        ) : (
          <ShieldAlert className="size-[18px] text-berry-ink" aria-hidden="true" />
        )}
        <span className="flex-1 text-[13px] leading-5">
          <strong className="font-semibold">Guard scan:</strong> {r.scanMessage}
        </span>
      </div>
      {r.guardResults.map((g, i) => (
        <GuardResultBlock key={`${g.guard}-${i}`} result={g} />
      ))}
      {canDecide ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="danger" onClick={() => setDeciding('reject')}>
            Keep blocking {r.itemKey}
          </Button>
          <Button
            variant="outline"
            disabled={r.verdict === 'malicious'}
            onClick={() => setDeciding('approve')}
          >
            Accept new definition
          </Button>
          {r.verdict === 'malicious' ? (
            <span className="text-caption text-muted">
              A malicious scan needs an Admin override with a reason.
            </span>
          ) : null}
        </div>
      ) : (
        <ReadOnlyNote>Read-only. A Manager of the owning team or an Admin decides.</ReadOnlyNote>
      )}
      {deciding ? (
        <DecisionDialog review={r} decision={deciding} onClose={() => setDeciding(null)} />
      ) : null}
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
            description="When a server changes a tool after approval, it shows up here for review."
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
                    <ServerIcon
                      letter={letterOf(r.serverName)}
                      color={tintOf(r.installationId ?? r.id)}
                      size={32}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[13px] leading-5 font-semibold">
                        {r.itemKey}
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
        subtitle="Guard blocks, changed definitions and denied network access, newest first."
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={<p className="m-0 text-muted">No findings in this period.</p>}
      >
        {(items) => (
          <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
            {items.map((f) => (
              <li
                key={`${f.kind}-${f.id}`}
                className="flex flex-col gap-1.5 rounded-md bg-sunken p-3.5"
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold">
                  <Tag
                    tone={f.kind === 'guard_block' ? 'bad' : f.kind === 'drift' ? 'warn' : 'info'}
                  >
                    {FINDING_KIND_LABEL[f.kind]}
                  </Tag>
                  <span className="ml-auto text-caption font-normal text-muted">
                    {formatRelative(f.ts)}
                  </span>
                </span>
                <span className="font-mono text-[12px]">{f.detail ?? 'No detail'}</span>
                {f.subject ? (
                  <span className="text-caption text-muted">{f.subjectName ?? f.subject}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

export function SecurityPage() {
  const { role } = useAuth();
  const orgView = role === 'admin' || role === 'auditor';
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
      {orgView ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <FindingsChart range={range} />
          <TopFlagged range={range} />
        </div>
      ) : (
        <ReadOnlyNote>
          Guard statistics and findings cover the whole org: admins and auditors see them.
        </ReadOnlyNote>
      )}
      <DriftQueue />
      {orgView ? <RecentFindings range={range} /> : null}
    </>
  );
}

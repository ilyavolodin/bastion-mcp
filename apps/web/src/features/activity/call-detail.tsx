import { ArrowUpRight, ShieldAlert, X } from 'lucide-react';
import { useCall } from '@/api/hooks';
import type { CallDetail, GuardFinding, TraceSpan } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { Overline, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { OutcomeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatClock, formatDuration } from '@/lib/format';

export const PHASE_COLOR: Record<string, string> = {
  claim: 'var(--sky)',
  bind: 'var(--teal)',
  install: 'var(--berry)',
  spawn: 'var(--sun)',
  connect: 'var(--tangerine)',
};

const GROUP_COLOR: Record<TraceSpan['group'], string> = {
  authn: 'var(--line-strong)',
  policy: 'var(--line-strong)',
  limits: 'var(--line-strong)',
  guard: 'var(--sky)',
  instance: 'var(--berry)',
  upstream: 'var(--teal)',
};

function Waterfall({ detail }: { detail: CallDetail }) {
  const total = Math.max(detail.totalMs, 1);
  const ticks = [0, total / 3, (total * 2) / 3, total];
  return (
    <section aria-label="Where the time went" className="flex flex-col gap-2">
      <Overline>Where the time went</Overline>
      <ul className="m-0 flex list-none flex-col p-0">
        {detail.spans.map((s) => (
          <li key={s.id} className="grid h-6 grid-cols-[128px_minmax(0,1fr)] items-center gap-2.5">
            <span className="truncate text-caption text-ink">{s.name}</span>
            <span
              className="relative h-3 rounded-[4px] bg-sunken"
              title={`${s.name}: ${formatDuration(s.durationMs)}`}
            >
              {s.phases ? (
                <span
                  className="absolute inset-y-0 flex overflow-hidden rounded-[4px]"
                  style={{
                    left: `${(s.startMs / total) * 100}%`,
                    width: `${Math.max((s.durationMs / total) * 100, 0.6)}%`,
                  }}
                >
                  {s.phases.map((p) => (
                    <span
                      key={p.name}
                      title={`${p.name}: ${formatDuration(p.durationMs)}`}
                      style={{ flex: p.durationMs, background: PHASE_COLOR[p.name] }}
                    />
                  ))}
                </span>
              ) : (
                <span
                  className="absolute inset-y-0 min-w-[3px] rounded-[4px]"
                  style={{
                    left: `${(s.startMs / total) * 100}%`,
                    width: `${(s.durationMs / total) * 100}%`,
                    background:
                      s.status === 'blocked'
                        ? 'var(--coral)'
                        : s.status === 'error'
                          ? 'var(--sun)'
                          : GROUP_COLOR[s.group],
                  }}
                />
              )}
              <span className="sr-only">
                {s.name} took {formatDuration(s.durationMs)}
                {s.status !== 'ok' ? `, ${s.status}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div
        className="grid grid-cols-[128px_minmax(0,1fr)] gap-2.5 text-[11px] text-muted"
        aria-hidden="true"
      >
        <span />
        <span className="flex justify-between">
          {ticks.map((t, i) => (
            <span key={i}>{i === 0 ? '0' : formatDuration(t)}</span>
          ))}
        </span>
      </div>
      {detail.spans.some((s) => s.phases) ? (
        <ul
          className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11px] text-muted"
          aria-label="Cold start phases"
        >
          {Object.entries(PHASE_COLOR).map(([name, color]) => (
            <li key={name} className="inline-flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ background: color }}
                aria-hidden="true"
              />
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const GUARD_LABEL: Record<GuardFinding['guard'], string> = {
  prompt_injection: 'Prompt injection',
  pii: 'PII',
  regex: 'Request guard',
  definition_drift: 'Definition drift',
};

/** A guard finding with the triggering segment highlighted in its context (18.3). */
export function FindingBlock({ finding }: { finding: GuardFinding }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-coral-soft p-3.5">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-coral-ink">
        <ShieldAlert className="size-4" aria-hidden="true" />
        {GUARD_LABEL[finding.guard]} · {finding.rule}
        <Tag tone="bad" className="ml-auto">
          {finding.action === 'block'
            ? 'Blocked'
            : finding.action === 'redact'
              ? 'Redacted'
              : 'Warned'}
        </Tag>
      </div>
      <code className="font-mono text-[12px] leading-[18px] text-ink">
        {finding.before}
        <mark>{finding.match}</mark>
        {finding.after}
      </code>
    </div>
  );
}

/** Call drawer: trace waterfall, guard findings, policy reasons, previews and the tracing link. */
export function CallDetailPanel({
  id,
  onClose,
  docked,
}: {
  id: string;
  onClose?: () => void;
  docked?: boolean;
}) {
  const q = useCall(id);
  const { me } = useAuth();
  const d = q.data;
  return (
    <aside
      aria-label="Call detail"
      className={cn(
        'flex flex-col gap-[18px] bg-surface',
        docked && 'w-[420px] shrink-0 self-start rounded-lg p-[22px] shadow-float',
      )}
    >
      {q.isPending ? (
        <div role="status" aria-label="Loading call" className="flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : q.isError ? (
        <ProblemAlert error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[15px] leading-[22px] font-semibold">{d.item}</div>
              <div className="text-caption text-muted">
                {[d.installationName, d.client, formatClock(d.startedAt, true)]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <OutcomeBadge
              outcome={d.outcome}
              label={d.outcome === 'blocked' ? 'Blocked' : undefined}
            />
            {onClose ? (
              <Button
                variant="sunken"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close call detail"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <Waterfall detail={d} />
          {d.findings.map((f) => (
            <FindingBlock key={f.id} finding={f} />
          ))}
          {d.errorMessage ? (
            <p
              role="alert"
              className="m-0 rounded-md bg-tangerine-soft p-3 text-[13px] text-tangerine-ink"
            >
              {d.errorMessage}
            </p>
          ) : null}
          <section aria-label="Policy decision" className="flex flex-col gap-1.5">
            <Overline>Policy decision</Overline>
            {d.policy.reasons.map((r) => (
              <div key={r.rule} className="flex items-center gap-2 text-[13px]">
                <Tag tone={r.effect === 'permit' ? 'ok' : 'bad'}>{r.effect}</Tag>
                <span className="font-mono text-[12px]">rule · {r.rule}</span>
              </div>
            ))}
          </section>
          {d.previews ? (
            <section aria-label="Previews" className="flex flex-col gap-1.5">
              <Overline>Arguments and result (redacted)</Overline>
              <pre className="m-0 overflow-x-auto rounded-md bg-sunken p-2.5 font-mono text-[12px]">
                {d.previews.args}
              </pre>
              <pre className="m-0 overflow-x-auto rounded-md bg-sunken p-2.5 font-mono text-[12px]">
                {d.previews.result}
              </pre>
            </section>
          ) : null}
          {me.org.traceUiUrl ? (
            <a
              href={`${me.org.traceUiUrl}/${d.traceId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-label no-underline"
            >
              Open in tracing backend
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

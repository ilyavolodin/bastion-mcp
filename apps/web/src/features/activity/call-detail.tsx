import { ArrowUpRight, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useCall, useNames } from '@/api/hooks';
import {
  type CallRow,
  callTitle,
  GUARD_ACTION_LABEL,
  type GuardResult,
  previewText,
  traceHref,
} from '@/api/views/observability';
import { useAuth } from '@/auth/auth';
import { Overline, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { OutcomeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatClock, formatDuration, formatNumber } from '@/lib/format';

/** Colours of the sandbox start phases (8.6); the servers screens chart them. */
export const PHASE_COLOR: Record<string, string> = {
  claim: 'var(--sky)',
  bind: 'var(--teal)',
  install: 'var(--berry)',
  spawn: 'var(--sun)',
  connect: 'var(--tangerine)',
};

const VERDICT_TONE = {
  clean: 'ok',
  suspicious: 'warn',
  malicious: 'bad',
  error: 'neutral',
} as const;

/** One guard's verdict on a call or a definition (13.1): who judged, in which phase, and what it did. */
export function GuardResultBlock({ result }: { result: GuardResult }) {
  const flagged = result.verdict === 'malicious' || result.verdict === 'suspicious';
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md p-3.5',
        flagged ? 'bg-coral-soft' : 'bg-sunken',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 text-[13px] font-semibold',
          flagged ? 'text-coral-ink' : 'text-ink',
        )}
      >
        {flagged ? (
          <ShieldAlert className="size-4" aria-hidden="true" />
        ) : (
          <ShieldCheck className="size-4" aria-hidden="true" />
        )}
        {result.guard}
        <Tag tone={VERDICT_TONE[result.verdict]} className="ml-auto">
          {result.verdict}
        </Tag>
      </div>
      <p className="m-0 text-caption text-muted">
        {result.type} guard · {result.phase} · {GUARD_ACTION_LABEL(result.action)} ·{' '}
        {formatDuration(result.latencyMs)}
        {result.score === undefined ? '' : ` · score ${result.score}`}
        {result.error ? ` · ${result.error}` : ''}
      </p>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-caption text-muted">{label}</dt>
    <dd className="m-0 text-[13px] font-medium">{value}</dd>
  </div>
);

function Facts({ call }: { call: CallRow }) {
  return (
    <dl aria-label="Timing and size" className="m-0 grid grid-cols-3 gap-3">
      <Fact label="Duration" value={formatDuration(call.durationMs)} />
      <Fact label="Cold start" value={call.coldStart ? 'Yes' : 'No'} />
      <Fact label="Method" value={call.method} />
      <Fact label="Sent" value={`${formatNumber(call.bytesIn)} B`} />
      <Fact label="Received" value={`${formatNumber(call.bytesOut)} B`} />
      <Fact label="Origin" value={call.origin} />
    </dl>
  );
}

/** Call drawer: what the call log recorded, the guard results, policy reasons, previews and the tracing link. */
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
  const names = useNames();
  const { me } = useAuth();
  const d = q.data;
  const server = d?.installationId ? names.data?.installations.get(d.installationId) : undefined;
  const person = d ? names.data?.users.get(d.principalId) : undefined;
  const trace = d ? traceHref(me.org.traceUiUrl, d.traceId) : null;
  const args = d ? previewText(d.argsPreview) : null;
  const result = d ? previewText(d.resultPreview) : null;
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
              <div className="font-mono text-[15px] leading-[22px] font-semibold">
                {callTitle(d)}
              </div>
              <div className="text-caption text-muted">
                {[server, d.clientName, person, formatClock(d.ts, true)]
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
          <Facts call={d} />
          {(d.guardResults ?? []).map((r, i) => (
            <GuardResultBlock key={`${r.guard}-${r.phase}-${i}`} result={r} />
          ))}
          {d.errorCode ? (
            <p
              role="alert"
              className="m-0 rounded-md bg-tangerine-soft p-3 text-[13px] text-tangerine-ink"
            >
              <span className="font-mono">{d.errorCode}</span>
              {d.jsonrpcCode === null ? '' : ` (JSON-RPC ${d.jsonrpcCode})`}
            </p>
          ) : null}
          <section aria-label="Policy decision" className="flex flex-col gap-1.5">
            <Overline>Policy decision</Overline>
            {(d.policyReasons ?? []).length === 0 ? (
              <span className="text-caption text-muted">No policy reason was recorded.</span>
            ) : (
              (d.policyReasons ?? []).map((r) => (
                <div key={r} className="flex items-center gap-2 text-[13px]">
                  <Tag tone={d.outcome === 'denied' ? 'bad' : 'ok'}>
                    {d.outcome === 'denied' ? 'deny' : 'permit'}
                  </Tag>
                  <span className="font-mono text-[12px]">{r}</span>
                </div>
              ))
            )}
          </section>
          {args || result ? (
            <section aria-label="Previews" className="flex flex-col gap-1.5">
              <Overline>Arguments and result (redacted)</Overline>
              {args ? (
                <pre className="m-0 overflow-x-auto rounded-md bg-sunken p-2.5 font-mono text-[12px]">
                  {args}
                </pre>
              ) : null}
              {result ? (
                <pre className="m-0 overflow-x-auto rounded-md bg-sunken p-2.5 font-mono text-[12px]">
                  {result}
                </pre>
              ) : null}
            </section>
          ) : null}
          {trace ? (
            <a
              href={trace}
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

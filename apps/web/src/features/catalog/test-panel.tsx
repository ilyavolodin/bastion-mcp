import { Check, TriangleAlert } from 'lucide-react';
import { useRunTest, useTestResult } from '@/api/hooks';
import type { TestResult } from '@/api/types';
import { Card, CardHeader } from '@/components/primitives';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDuration } from '@/lib/format';
import { PHASE_COLOR } from '../activity/call-detail';

const SOFT: Record<string, string> = {
  claim: 'var(--sky-soft)',
  bind: 'var(--mint-soft)',
  install: 'var(--berry-soft)',
  spawn: 'var(--coral-soft)',
  connect: 'var(--tangerine-soft)',
};

export function PhaseTimeline({ phases }: { phases: TestResult['phases'] }) {
  const total = phases.reduce((n, p) => n + p.durationMs, 0) || 1;
  return (
    <ol aria-label="Start phases" className="m-0 flex h-10 list-none gap-[3px] p-0">
      {phases.map((p) => (
        <li
          key={p.name}
          className="flex min-w-14 flex-col justify-center overflow-hidden rounded-sm px-2 text-ink"
          style={{
            flex: Math.max(p.durationMs / total, 0.08),
            background: SOFT[p.name],
            borderBottom: `3px solid ${PHASE_COLOR[p.name]}`,
          }}
        >
          <span className="whitespace-nowrap text-[11px] leading-[14px] font-semibold">
            {p.name}
          </span>
          <span className="whitespace-nowrap text-[11px] leading-[14px]">
            {formatDuration(p.durationMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A passing test of the exact version is what enables Publish (11.3). */
export const isPassing = (t: TestResult | null | undefined, versionLabel: string): boolean =>
  t?.status === 'passed' && t.versionLabel === versionLabel;

/**
 * The Test step: start phases as a horizontal timeline, discovered capabilities, the guard scan and
 * stderr. Polls while the test runs (the server also pushes `test.progress` over SSE).
 */
export function TestPanel({
  entryId,
  versionId,
  canRun,
  onBeforeRun,
}: {
  entryId: string;
  versionId: string | null;
  versionLabel: string;
  canRun: boolean;
  /** Saves the draft first when needed and returns the version id to test. */
  onBeforeRun?: () => Promise<string | null>;
}) {
  const run = useRunTest(entryId, versionId ?? '');
  const result = useTestResult(entryId, versionId);
  const t = result.data;
  const running = t?.status === 'running' || run.isPending;
  const start = async () => {
    const id = onBeforeRun ? await onBeforeRun() : versionId;
    if (id) run.mutate();
  };
  return (
    <div className="flex flex-col gap-6">
      <Card aria-label="Test start" className="gap-3.5">
        <CardHeader
          title="Test run"
          actions={
            <>
              {t ? (
                t.status === 'passed' ? (
                  <StatusPill
                    tone="ok"
                    label={`Passed as ${t.ranAs === 'Dana Whitfield' ? 'you' : t.ranAs}`}
                  />
                ) : t.status === 'failed' ? (
                  <StatusPill tone="bad" label="Failed" />
                ) : (
                  <StatusPill tone="info" label="Running" />
                )
              ) : null}
              <Button variant="outline" size="sm" disabled={!canRun || running} onClick={start}>
                {running ? 'Running…' : t ? 'Run again' : 'Run test'}
              </Button>
            </>
          }
        />
        {!t && !running ? (
          <p className="m-0 text-muted">
            The test starts the server as you, lists what it offers and scans every description.
          </p>
        ) : null}
        {t ? (
          <PhaseTimeline phases={t.phases} />
        ) : running ? (
          <Skeleton className="h-10 w-full" />
        ) : null}
        {t && t.status !== 'running' ? (
          <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['tools', t.counts.tools],
                ['prompts', t.counts.prompts],
                ['resource templates', t.counts.templates],
                ['resources', t.counts.resources],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="flex items-center gap-2.5 rounded-md bg-sunken p-3">
                <dd className="m-0 text-figure-lg">{n}</dd>
                <dt className="text-caption text-muted">{label}</dt>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      {t && t.status !== 'running' ? (
        <>
          <Card aria-label="Guard scan" className="gap-1">
            <CardHeader title="Tool description scan" className="mb-2" />
            {t.scan.map((s) => (
              <div key={s.item} className="flex min-h-11 items-center gap-3 border-b border-line">
                <span
                  className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full ${s.verdict === 'clean' ? 'bg-mint-soft text-mint-ink' : 'bg-tangerine-soft text-tangerine-ink'}`}
                >
                  {s.verdict === 'clean' ? (
                    <Check className="size-3.5" strokeWidth={2.5} aria-label="Clean" role="img" />
                  ) : (
                    <TriangleAlert className="size-3.5" aria-label="Needs attention" role="img" />
                  )}
                </span>
                <span className="min-w-[180px] font-mono text-[13px] font-semibold">{s.item}</span>
                <span className="flex-1 text-[13px] text-muted">{s.message}</span>
              </div>
            ))}
          </Card>
          <section
            aria-label="Server output"
            className="flex flex-col gap-2 rounded-lg bg-[#171a3a] px-5 py-[18px] text-[#f4f4f6]"
          >
            <span className="text-overline !text-[#a7a9b8]">stderr</span>
            <pre className="m-0 whitespace-pre-wrap font-mono text-[12px] leading-5">
              {t.stderr.map((l, i) => (
                <span key={i} className={l.startsWith('warn') ? 'block text-[#ffc84f]' : 'block'}>
                  {l}
                </span>
              ))}
            </pre>
          </section>
        </>
      ) : null}
    </div>
  );
}

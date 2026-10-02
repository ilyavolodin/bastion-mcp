import { Check, CircleDashed, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useCatalogVersion, useRunTest } from '@/api/hooks';
import { stepLabel, type VersionTestRun } from '@/api/views/catalog';
import { Card, CardHeader } from '@/components/primitives';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type Step = VersionTestRun['steps'][number];

const ICON: Record<Step['status'], { tone: string; icon: React.ReactNode; label: string }> = {
  passed: {
    tone: 'bg-mint-soft text-mint-ink',
    icon: <Check className="size-3.5" strokeWidth={2.5} aria-label="Passed" role="img" />,
    label: 'Passed',
  },
  failed: {
    tone: 'bg-coral-soft text-coral-ink',
    icon: <X className="size-3.5" strokeWidth={2.5} aria-label="Failed" role="img" />,
    label: 'Failed',
  },
  running: {
    tone: 'bg-sky-soft text-sky-ink',
    icon: <LoaderCircle className="size-3.5 animate-spin" aria-label="Running" role="img" />,
    label: 'Running',
  },
  skipped: {
    tone: 'bg-sunken text-muted',
    icon: <TriangleAlert className="size-3.5" aria-label="Skipped" role="img" />,
    label: 'Skipped',
  },
  pending: {
    tone: 'bg-sunken text-muted',
    icon: <CircleDashed className="size-3.5" aria-label="Pending" role="img" />,
    label: 'Pending',
  },
};

export function StepList({ steps }: { steps: VersionTestRun['steps'] }) {
  return (
    <ol aria-label="Test steps" className="m-0 flex list-none flex-col p-0">
      {steps.map((s) => {
        const i = ICON[s.status];
        return (
          <li key={s.id} className="flex min-h-11 items-start gap-3 border-b border-line py-2.5">
            <span
              className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full ${i.tone}`}
            >
              {i.icon}
            </span>
            <span className="min-w-[200px] text-[13px] font-semibold">{stepLabel(s.id)}</span>
            <span className="flex-1 whitespace-pre-wrap text-[13px] text-muted">
              {s.detail ?? i.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The Test step (11.2): the steps of the latest run of this version (snapshot, guard scan, OSV, lockfile, ...) as
 * the API reports them. The run lives on the version row; the panel polls it while it runs (the server also pushes
 * `test.progress` over SSE). Any change to the version clears the run, so a passing run is a passing run of this
 * exact version (11.3).
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
  const version = useCatalogVersion(entryId, versionId ?? undefined);
  const t = version.data?.testResult ?? undefined;
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
                  <StatusPill tone="ok" label="Passed" />
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
        {t ? <StepList steps={t.steps} /> : running ? <Skeleton className="h-10 w-full" /> : null}
      </Card>
    </div>
  );
}

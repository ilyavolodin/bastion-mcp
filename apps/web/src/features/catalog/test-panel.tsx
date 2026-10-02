import { Check, CircleDashed, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import * as React from 'react';
import {
  useCatalogVersion,
  useMySecretNames,
  useOrgSecretNames,
  useRunTest,
  useSetMySecret,
} from '@/api/hooks';
import { stepLabel, type VersionTestRun } from '@/api/views/catalog';
import { useAuth } from '@/auth/auth';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { StatusPill } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { type SpecDraft, secretNamesOf } from './draft';

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
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-muted">
              {s.detail ?? i.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Why a run failed, in one line: the detail of its first failed step. */
export const failureReason = (run: VersionTestRun | undefined): string | undefined => {
  const failed = run?.steps.find((s) => s.status === 'failed');
  if (!failed) return undefined;
  const first = (failed.detail ?? '').split('\n')[0]?.trim();
  return `${stepLabel(failed.id)}: ${first || 'failed'}`;
};

/** What the author still has to give before a test can start (11.3): values the server needs and cannot guess. */
export const testNeeds = (
  spec: SpecDraft | undefined,
): {
  /** Variables that are required, have no default and are not choices with a first option. */
  variables: { name: string; label: string }[];
  /** Personal secret fields: the author's own values. */
  mySecrets: { name: string; label: string }[];
  /** Shared secrets: set in Authentication, only reported here. */
  orgSecrets: string[];
} => ({
  variables: (spec?.variables ?? [])
    .filter((v) => v.required && !v.default)
    .map((v) => ({ name: v.name, label: v.label || v.name })),
  mySecrets:
    spec?.authMode === 'userSecret'
      ? secretNamesOf(spec).map((name) => ({
          name,
          label: spec.secretLabels[name]?.trim() || name,
        }))
      : [],
  orgSecrets: spec?.authMode === 'orgSecret' ? secretNamesOf(spec) : [],
});

/**
 * The Test step (11.3): the steps of the latest run of this version as the API reports them, with the verdict and the
 * reason on top. The run lives on the version row; the panel polls it while it runs (the server also pushes
 * `test.progress` over SSE). Any change to the version clears the run, so a passing run is a passing run of this exact
 * version. A run started here that passes moves the editor on to Publish (`onPassed`).
 */
export function TestPanel({
  entryId,
  versionId,
  spec,
  canRun,
  autoRun,
  onBeforeRun,
  onPassed,
  onAutoRunStarted,
}: {
  entryId: string;
  versionId: string | null;
  /** The server spec being tested (absent for skills and plugins, which need no values). */
  spec?: SpecDraft | undefined;
  canRun: boolean;
  /** Start a run as soon as the panel is ready (a new entry that was just saved from the Test step). */
  autoRun?: boolean;
  /** Saves the draft first when needed and returns the version id to test. */
  onBeforeRun?: () => Promise<string | null>;
  onPassed?: () => void;
  onAutoRunStarted?: () => void;
}) {
  const { me } = useAuth();
  const run = useRunTest(entryId, versionId ?? '');
  const setMine = useSetMySecret();
  const version = useCatalogVersion(entryId, versionId ?? undefined);
  const t = version.data?.testResult ?? undefined;
  const needs = React.useMemo(() => testNeeds(spec), [spec]);
  const mine = useMySecretNames(needs.mySecrets.length > 0);
  const org = useOrgSecretNames(needs.orgSecrets.length > 0);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [starting, setStarting] = React.useState(false);
  const startedHere = React.useRef(false);
  const running = t?.status === 'running' || run.isPending || starting;

  const missingVars = needs.variables.filter((v) => !values[v.name]?.trim());
  const missingMine = needs.mySecrets.filter(
    (s) => !values[`secret:${s.name}`] && !mine.data?.has(s.name),
  );
  const blocked = [
    ...missingVars.map((v) => `a value for ${v.label}`),
    ...missingMine.map((s) => `your ${s.label}`),
  ];

  const start = async () => {
    if (blocked.length > 0) return;
    setStarting(true);
    try {
      const id = onBeforeRun ? await onBeforeRun() : versionId;
      if (!id) return;
      for (const s of needs.mySecrets) {
        const value = values[`secret:${s.name}`];
        if (value) await setMine.mutateAsync({ userId: me.id, name: s.name, value });
      }
      const variables = Object.fromEntries(
        needs.variables.flatMap((v) =>
          values[v.name] ? [[v.name, values[v.name] as string]] : [],
        ),
      );
      startedHere.current = true;
      await run.mutateAsync({ variables });
    } finally {
      setStarting(false);
    }
  };

  // A run started in this panel that ends passed moves the editor on to Publish.
  React.useEffect(() => {
    if (startedHere.current && t?.status === 'passed') {
      startedHere.current = false;
      onPassed?.();
    }
    if (t?.status === 'failed') startedHere.current = false;
  }, [t?.status, onPassed]);

  const autoRan = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, when the saved version is ready
  React.useEffect(() => {
    if (!autoRun || autoRan.current || !versionId || version.isLoading) return;
    autoRan.current = true;
    onAutoRunStarted?.();
    if (blocked.length === 0) void start();
  }, [autoRun, versionId, version.isLoading]);

  const reason = failureReason(t);
  const hasInputs =
    needs.variables.length > 0 || needs.mySecrets.length > 0 || needs.orgSecrets.length > 0;
  return (
    <div className="flex flex-col gap-6">
      {hasInputs ? (
        <Card aria-label="Test values" className="gap-3.5">
          <CardHeader title="Values for this test" subtitle="The test starts the server as you" />
          {needs.variables.map((v) => (
            <Field key={v.name} label={v.label}>
              {({ id }) => (
                <Input
                  id={id}
                  autoComplete="off"
                  value={values[v.name] ?? ''}
                  onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                />
              )}
            </Field>
          ))}
          {needs.mySecrets.map((s) => (
            <Field
              key={s.name}
              label={s.label}
              help={
                mine.data?.has(s.name)
                  ? 'Set. Type to replace.'
                  : 'Your own value, stored encrypted.'
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  aria-describedby={describedBy}
                  value={values[`secret:${s.name}`] ?? ''}
                  onChange={(e) => setValues({ ...values, [`secret:${s.name}`]: e.target.value })}
                />
              )}
            </Field>
          ))}
          {needs.orgSecrets.map((name) => (
            <p key={name} className="m-0 text-[13px]">
              Shared secret <code>{name}</code>:{' '}
              {org.data?.has(name) ? (
                <span className="font-medium text-mint-ink">set</span>
              ) : (
                <span className="font-medium text-coral-ink">
                  not set yet. Enter it in Authentication and save the draft.
                </span>
              )}
            </p>
          ))}
        </Card>
      ) : null}
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
              <Button
                variant={t?.status === 'passed' ? 'outline' : 'primary'}
                size="sm"
                disabled={!canRun || running || blocked.length > 0}
                onClick={() => void start()}
              >
                {running ? 'Running…' : t ? 'Run again' : 'Run test'}
              </Button>
            </>
          }
        />
        {blocked.length > 0 && !running ? (
          <p className="m-0 text-caption text-muted">
            Enter {blocked.join(' and ')} to run the test.
          </p>
        ) : null}
        {t?.status === 'failed' ? (
          <div role="alert" className="rounded-md bg-coral-soft p-3 text-[13px] text-ink">
            <p className="m-0 font-semibold text-coral-ink">The test failed</p>
            <p className="m-0 mt-1 whitespace-pre-wrap break-words">
              {reason ?? 'The run ended without a result.'}
            </p>
            <p className="m-0 mt-1 text-muted">
              Fix it on the step it names, save, and run the test again. You can still go back and
              forward between steps.
            </p>
          </div>
        ) : null}
        {t?.status === 'passed' ? (
          <p
            role="status"
            className="m-0 rounded-md bg-mint-soft p-3 text-[13px] font-medium text-mint-ink"
          >
            The test passed. Publish becomes available for exactly this version.
          </p>
        ) : null}
        {running && t?.status !== 'failed' && t?.status !== 'passed' ? (
          <p role="status" className="m-0 text-[13px] text-muted">
            The test is running. This can take a minute when the server starts for the first time.
          </p>
        ) : null}
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

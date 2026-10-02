import { useNavigate, useParams } from '@tanstack/react-router';
import { CircleCheck, CircleX, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import {
  type CatalogEntryDetail,
  useCatalogEntry,
  useCatalogVersion,
  useCreateCatalogEntry,
  usePublish,
  useSaveDraft,
  useTeamOptions,
} from '@/api/hooks';
import { bumpLabel, editableVersion, isPassing } from '@/api/views/catalog';
import { useAuth } from '@/auth/auth';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { QueryBoundary } from '@/components/query-boundary';
import { Stepper } from '@/components/stepper';
import { Button } from '@/components/ui/button';
import { useSearchState } from '@/lib/search';
import {
  type Draft,
  draftOf,
  draftToSpec,
  emptyDraft,
  installFormOf,
  validateDraft,
} from './draft';
import {
  AuthenticationStep,
  ConfigurationStep,
  NetworkStep,
  OverridesStep,
  SecurityStep,
  SourceStep,
} from './editor-steps';
import { DeleteEntryDialog, STATUS, useCanManageEntry } from './entry-actions';
import { AutoInstallCard, PublishCard } from './publish-card';
import { failureReason, TestPanel } from './test-panel';

export const STEPS = [
  { id: 'source', label: 'Source' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'network', label: 'Network' },
  { id: 'overrides', label: 'Overrides' },
  { id: 'security', label: 'Security and limits' },
  { id: 'test', label: 'Test' },
  { id: 'publish', label: 'Publish' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const searchSchema = z.object({
  step: z
    .enum(STEPS.map((s) => s.id) as [StepId, ...StepId[]])
    .catch('source')
    .default('source'),
  /** Set when a new entry was saved from the Test step: the test starts once the saved entry has loaded. */
  run: z.string().optional(),
});

/** Server-side field errors (`/slug`) keyed by the first path segment. */
const fieldErrorsOf = (e: ApiError): Record<string, string> =>
  Object.fromEntries(
    e.errors.map((f) => [f.path.replace(/^\//, '').split('/')[0] ?? '', f.message]),
  );

/** The step that edits what a server-side error path points at. */
export const stepOfPath = (path: string): StepId => {
  const p = path.replace(/^\//, '');
  if (/^serverSpec\/(auth|headers)/.test(p)) return 'authentication';
  if (/^serverSpec\/(environmentVariables|packageArguments|variables)/.test(p))
    return 'configuration';
  if (/^serverSpec\/egress/.test(p)) return 'network';
  if (/^overrides/.test(p)) return 'overrides';
  return 'source';
};

/** Everything that, when it changes, makes an earlier test stale: the saved version row (11.2). */
const versionKey = (d: Draft): string =>
  JSON.stringify([
    d.label.trim(),
    draftToSpec(d.spec),
    installFormOf(d.spec),
    d.overrides,
    d.spec.secretValues,
  ]);

function Editor({ detail }: { detail: CatalogEntryDetail | null }) {
  const navigate = useNavigate();
  const { role, me } = useAuth();
  const [s, setS] = useSearchState(searchSchema);
  const entry = detail?.entry ?? null;
  const version = detail ? editableVersion(detail.versions) : undefined;
  const init = React.useMemo(() => {
    if (!detail) {
      const fresh = emptyDraft();
      const managed = me.teams.find((t) => t.role === 'manager');
      // A Manager owns what they author through a team they manage (10.1).
      return role === 'manager' && managed ? { ...fresh, ownerTeamId: managed.id } : fresh;
    }
    const label = !version
      ? '0.1.0'
      : version.status === 'draft'
        ? version.label
        : bumpLabel(version.label);
    return draftOf(detail.entry, version, label);
  }, [detail, version, me, role]);
  const [draft, setDraft] = React.useState<Draft>(init);
  // `dirty`: anything changed since the last save. `savedKey`: the part that makes a test stale (the version).
  const [dirty, setDirty] = React.useState(false);
  const [savedKey, setSavedKey] = React.useState(() => versionKey(init));
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const create = useCreateCatalogEntry();
  const saveDraft = useSaveDraft(entry?.id ?? '', version);
  const draftVersion = version?.status === 'draft' ? version : undefined;
  const publish = usePublish(entry?.id ?? '', draftVersion?.id ?? '');
  const current = useCatalogVersion(entry?.id, draftVersion?.id);
  const change = (d: Draft) => {
    setDraft(d);
    setDirty(true);
  };
  const label = draft.label || version?.label || '0.1.0';
  const versionDirty = versionKey(draft) !== savedKey;
  const testRun = current.data?.testResult ?? undefined;
  const passing = !versionDirty && Boolean(draftVersion) && isPassing(testRun);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const mayDelete = useCanManageEntry(entry ?? { ownerTeamId: null });

  const save = async (options: { run?: boolean } = {}): Promise<string | null> => {
    const issues = validateDraft(draft);
    const first = issues[0];
    if (first) {
      setSaveError(null);
      toast.error(first.message);
      setS({ step: first.step as StepId });
      return null;
    }
    setSaving(true);
    setErrors({});
    setSaveError(null);
    try {
      if (!entry) {
        const created = await create.mutateAsync(draft);
        toast.success('Draft saved');
        void navigate({
          to: `/catalog/${created.entry.id}`,
          search: { step: s.step, ...(options.run ? { run: '1' } : {}) },
          replace: true,
        } as never);
        return created.version.id;
      }
      const saved = await saveDraft.mutateAsync(draft);
      // The typed shared-secret values are written and forgotten.
      const forgotten: Draft = { ...draft, spec: { ...draft.spec, secretValues: {} } };
      setDraft(forgotten);
      setSavedKey(versionKey(forgotten));
      setDirty(false);
      toast.success('Draft saved');
      if (options.run) setS({ run: '1' });
      return saved.id;
    } catch (e) {
      setSaveError(e);
      if (e instanceof ApiError) {
        setErrors(fieldErrorsOf(e));
        toast.error(e.detail || e.title);
        setS({ step: stepOfPath(e.errors[0]?.path ?? '') });
        return null;
      }
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const stepIndex = STEPS.findIndex((x) => x.id === s.step);
  const props = { draft, onChange: change, errors, existing: Boolean(entry) };
  const onPublish = async () => {
    // Entry-level changes (who gets it, risk) save with the publish; the version is already the tested one.
    if (dirty && !(await save())) return;
    publish.mutate(
      { visibility: draft.visibility },
      {
        onSuccess: () => {
          toast.success(`${draft.displayName} v${label} is in the Store`);
          void navigate({ to: '/catalog' });
        },
      },
    );
  };
  const disabledReason = !entry
    ? 'Save the draft and run its test to publish it.'
    : versionDirty
      ? 'You changed this version since its last test. Save it and run the test again.'
      : testRun?.status === 'running'
        ? 'The test is running.'
        : testRun?.status === 'failed'
          ? 'The last test failed. Fix the problem and run the test again.'
          : 'Publish needs a passing test of this exact version. Run the test.';
  return (
    <>
      <PageHeader
        back={{ to: '/catalog', label: 'Catalog' }}
        title={draft.displayName || 'New entry'}
        badge={
          <Tag tone={STATUS[entry?.status ?? 'draft'].tone}>
            {STATUS[entry?.status ?? 'draft'].label}
          </Tag>
        }
        actions={
          <>
            {entry && mayDelete ? (
              <Button
                variant="outline"
                className="text-coral-ink"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {entry.status === 'draft' ? 'Delete draft' : 'Delete entry'}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={saving || (!dirty && Boolean(entry))}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save draft'}
            </Button>
          </>
        }
      />
      {entry ? (
        <DeleteEntryDialog
          entry={entry}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onDeleted={() => void navigate({ to: '/catalog' })}
        />
      ) : null}
      <Stepper
        steps={[...STEPS]}
        current={s.step}
        onSelect={(id) => setS({ step: id as StepId })}
        label="Catalog steps"
        {...(passing ? { readyId: 'publish' } : {})}
      />
      {passing && s.step !== 'publish' ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg bg-mint-soft px-4 py-3 text-[13px] font-medium text-mint-ink"
        >
          <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">This version passed its test: it is ready to publish.</span>
          <Button size="xs" onClick={() => setS({ step: 'publish' })}>
            Go to Publish
          </Button>
        </div>
      ) : null}
      {saveError ? <ProblemAlert error={saveError} /> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {s.step === 'source' ? <SourceStep {...props} /> : null}
          {s.step === 'configuration' ? <ConfigurationStep {...props} /> : null}
          {s.step === 'authentication' ? <AuthenticationStep {...props} /> : null}
          {s.step === 'network' ? <NetworkStep {...props} /> : null}
          {s.step === 'overrides' ? <OverridesStep {...props} /> : null}
          {s.step === 'security' ? <SecurityStep {...props} /> : null}
          {s.step === 'test' ? (
            entry && draftVersion ? (
              <TestPanel
                entryId={entry.id}
                versionId={draftVersion.id}
                spec={draft.spec}
                canRun
                autoRun={s.run === '1'}
                onAutoRunStarted={() => setS({ run: undefined })}
                onBeforeRun={async () => (dirty || versionDirty ? await save() : draftVersion.id)}
                onPassed={() => setS({ step: 'publish' })}
              />
            ) : (
              <Card aria-label="Test start" className="gap-3">
                <CardHeader title="Test run" />
                <p className="m-0 text-muted">
                  The test starts the server as you. Saving the draft comes first: this saves it and
                  runs the test in one go.
                </p>
                <Button
                  className="self-start"
                  onClick={() => void save({ run: true })}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save and run test'}
                </Button>
              </Card>
            )
          ) : null}
          {s.step === 'publish' ? (
            <PublishSummary
              draft={draft}
              label={label}
              hasEntry={Boolean(entry)}
              versionDirty={versionDirty}
              passing={passing}
              status={testRun?.status}
              reason={failureReason(testRun)}
              finishedAt={testRun?.finishedAt ?? null}
              onGoTest={() => setS({ step: 'test' })}
              onPublish={() => void onPublish()}
              publishing={publish.isPending || saving}
              disabledReason={disabledReason}
              checking={Boolean(draftVersion) && current.isPending}
            />
          ) : null}
          <div className="flex justify-between">
            <Button
              variant="outline"
              disabled={stepIndex <= 0}
              onClick={() => setS({ step: STEPS[stepIndex - 1]?.id })}
            >
              Back
            </Button>
            <Button
              variant="soft"
              disabled={stepIndex >= STEPS.length - 1}
              onClick={() => setS({ step: STEPS[stepIndex + 1]?.id })}
            >
              Next step
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <PublishCard
            draft={draft}
            onChange={(p) => change({ ...draft, ...p })}
            versionLabel={label}
            canPublish={passing}
            publishing={publish.isPending || saving}
            disabledReason={disabledReason}
            entryId={entry?.id}
            onPublish={() => void onPublish()}
          />
          <AutoInstallCard entryId={entry?.id} />
        </div>
      </div>
    </>
  );
}

/** The Publish step: what is about to go out, and the one big button, or the exact reason it is off (11.3). */
function PublishSummary({
  draft,
  label,
  hasEntry,
  versionDirty,
  passing,
  status,
  reason,
  finishedAt,
  onGoTest,
  onPublish,
  publishing,
  disabledReason,
  checking,
}: {
  draft: Draft;
  label: string;
  hasEntry: boolean;
  versionDirty: boolean;
  passing: boolean;
  status: 'running' | 'passed' | 'failed' | undefined;
  reason: string | undefined;
  finishedAt: string | null;
  onGoTest: () => void;
  onPublish: () => void;
  publishing: boolean;
  disabledReason: string;
  /** The version's test result is still loading: say nothing about it yet. */
  checking: boolean;
}) {
  const s = draft.spec;
  const teams = useTeamOptions();
  const source = s.type === 'remote' ? s.url : `${s.runtime}: ${s.identifier}@${s.version}`;
  const v = draft.visibility;
  const who = v.org
    ? 'Everyone in the organization'
    : v.teamIds.length
      ? v.teamIds.map((id) => (teams.data ?? []).find((t) => t.id === id)?.name ?? id).join(', ')
      : 'Nobody yet: choose teams on the right';
  return (
    <Card aria-label="Ready to publish" className="gap-3.5">
      <CardHeader title="Ready to publish" />
      <dl className="m-0 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Name</dt>
        <dd className="m-0 font-medium">{draft.displayName}</dd>
        <dt className="text-muted">Version</dt>
        <dd className="m-0 font-medium">{label}</dd>
        <dt className="text-muted">Source</dt>
        <dd className="m-0 break-all font-mono">{source}</dd>
        <dt className="text-muted">Who gets it</dt>
        <dd className="m-0 font-medium">{who}</dd>
        <dt className="text-muted">Risk</dt>
        <dd className="m-0 font-medium capitalize">{draft.risk}</dd>
      </dl>
      {passing ? (
        <p
          role="status"
          className="m-0 flex items-center gap-2 text-[13px] font-medium text-mint-ink"
        >
          <CircleCheck className="size-4" aria-hidden="true" />
          This exact version passed its test
          {finishedAt ? ` (${new Date(finishedAt).toLocaleString()})` : ''}. Choose who gets it and
          publish.
        </p>
      ) : checking ? (
        <p role="status" className="m-0 text-[13px] text-muted">
          Checking the test result of this version…
        </p>
      ) : (
        <div role="status" className="flex flex-col items-start gap-2">
          <p className="m-0 flex items-center gap-2 text-[13px] font-medium text-coral-ink">
            <CircleX className="size-4" aria-hidden="true" />
            {!hasEntry
              ? 'This draft is not saved or tested yet.'
              : versionDirty
                ? 'This version changed since its last test.'
                : status === 'failed'
                  ? `The last test failed${reason ? `: ${reason}` : '.'}`
                  : status === 'running'
                    ? 'The test is still running.'
                    : 'This version has not been tested.'}
          </p>
          <p className="m-0 text-[13px] text-muted">{disabledReason}</p>
        </div>
      )}
      <Button size="lg" className="w-full" disabled={!passing || publishing} onClick={onPublish}>
        {publishing ? 'Publishing…' : `Publish v${label} to the Store`}
      </Button>
      {!passing && !checking ? (
        <Button variant="outline" size="sm" className="self-start" onClick={onGoTest}>
          Go to the Test step
        </Button>
      ) : null}
    </Card>
  );
}

export function CatalogEditorPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useCatalogEntry(id === 'new' ? undefined : id);
  if (id === 'new') return <Editor key="new" detail={null} />;
  return (
    <QueryBoundary query={q} label="Loading entry">
      {(d) => <Editor key={d.entry.id} detail={d} />}
    </QueryBoundary>
  );
}

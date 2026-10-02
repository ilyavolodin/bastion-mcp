import { useNavigate, useParams } from '@tanstack/react-router';
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
} from '@/api/hooks';
import { bumpLabel, editableVersion, isPassing } from '@/api/views/catalog';
import { PageHeader } from '@/components/page-header';
import { Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Stepper } from '@/components/stepper';
import { Button } from '@/components/ui/button';
import { useSearchState } from '@/lib/search';
import { type Draft, draftOf, emptyDraft, validateDraft } from './draft';
import {
  AuthenticationStep,
  ConfigurationStep,
  NetworkStep,
  OverridesStep,
  SecurityStep,
  SourceStep,
} from './editor-steps';
import { AutoInstallCard, PublishCard } from './publish-card';
import { TestPanel } from './test-panel';

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
});

/** Server-side field errors (`/slug`) keyed by the first path segment. */
const fieldErrorsOf = (e: ApiError): Record<string, string> =>
  Object.fromEntries(
    e.errors.map((f) => [f.path.replace(/^\//, '').split('/')[0] ?? '', f.message]),
  );

function Editor({ detail }: { detail: CatalogEntryDetail | null }) {
  const navigate = useNavigate();
  const [s, setS] = useSearchState(searchSchema);
  const entry = detail?.entry ?? null;
  const version = detail ? editableVersion(detail.versions) : undefined;
  const init = React.useMemo(() => {
    if (!detail) return emptyDraft();
    const label = !version
      ? '0.1.0'
      : version.status === 'draft'
        ? version.label
        : bumpLabel(version.label);
    return draftOf(detail.entry, version, label);
  }, [detail, version]);
  const [draft, setDraft] = React.useState<Draft>(init);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
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
  const passing = !dirty && Boolean(draftVersion) && isPassing(current.data?.testResult);

  const save = async (): Promise<string | null> => {
    const issues = validateDraft(draft);
    const first = issues[0];
    if (first) {
      toast.error(first.message);
      setS({ step: first.step as StepId });
      return null;
    }
    setSaving(true);
    setErrors({});
    try {
      if (!entry) {
        const created = await create.mutateAsync(draft);
        toast.success('Draft saved');
        void navigate({
          to: `/catalog/${created.entry.id}`,
          search: { step: s.step },
          replace: true,
        } as never);
        return created.version.id;
      }
      const saved = await saveDraft.mutateAsync(draft);
      setDirty(false);
      toast.success('Draft saved');
      return saved.id;
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(fieldErrorsOf(e));
        toast.error(e.detail || e.title);
        setS({ step: 'source' });
        return null;
      }
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const stepIndex = STEPS.findIndex((x) => x.id === s.step);
  const props = { draft, onChange: change, errors, existing: Boolean(entry) };
  return (
    <>
      <PageHeader
        back={{ to: '/catalog', label: 'Catalog' }}
        title={draft.displayName || 'New entry'}
        badge={
          <Tag tone={entry?.status === 'published' ? 'ok' : 'warn'}>
            {entry?.status === 'published' ? 'Published' : 'Draft'}
          </Tag>
        }
        actions={
          <Button
            variant="outline"
            disabled={saving || (!dirty && Boolean(entry))}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </Button>
        }
      />
      <Stepper
        steps={[...STEPS]}
        current={s.step}
        onSelect={(id) => setS({ step: id as StepId })}
        label="Catalog steps"
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {s.step === 'source' ? <SourceStep {...props} /> : null}
          {s.step === 'configuration' ? <ConfigurationStep {...props} /> : null}
          {s.step === 'authentication' ? <AuthenticationStep {...props} /> : null}
          {s.step === 'network' ? <NetworkStep {...props} /> : null}
          {s.step === 'overrides' ? <OverridesStep {...props} /> : null}
          {s.step === 'security' ? <SecurityStep {...props} /> : null}
          {s.step === 'test' || s.step === 'publish' ? (
            entry && draftVersion ? (
              <TestPanel
                entryId={entry.id}
                versionId={draftVersion.id}
                versionLabel={label}
                canRun
                onBeforeRun={async () => (dirty ? await save() : draftVersion.id)}
              />
            ) : (
              <div className="rounded-lg bg-surface p-5 shadow-card">
                <p className="m-0 mb-3 text-muted">
                  Save the draft to run its test. The test starts the server as you.
                </p>
                <Button onClick={() => void save()} disabled={saving}>
                  Save draft
                </Button>
              </div>
            )
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
            publishing={publish.isPending}
            disabledReason={
              dirty
                ? 'Save and test this version to publish it.'
                : 'Publish needs a passing test of this exact version.'
            }
            entryId={entry?.id}
            onPublish={() =>
              publish.mutate(
                { visibility: draft.visibility },
                {
                  onSuccess: () => {
                    toast.success(`${draft.displayName} v${label} is in the Store`);
                    void navigate({ to: '/catalog' });
                  },
                },
              )
            }
          />
          <AutoInstallCard entryId={entry?.id} />
        </div>
      </div>
    </>
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

import { useNavigate, useParams } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/api/client';
import { useCatalogEntry, useCreateCatalogEntry, usePublish, useTestResult } from '@/api/hooks';
import type { CatalogEntryDetail, CatalogVersion } from '@/api/types';
import { PageHeader } from '@/components/page-header';
import { Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Stepper } from '@/components/stepper';
import { Button } from '@/components/ui/button';
import { useSearchState } from '@/lib/search';
import { defaultSpec } from './default-spec';
import {
  AuthenticationStep,
  ConfigurationStep,
  type Draft,
  NetworkStep,
  OverridesStep,
  SecurityStep,
  SourceStep,
} from './editor-steps';
import { AutoInstallCard, PublishCard } from './publish-card';
import { isPassing, TestPanel } from './test-panel';

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

const searchSchema = z.object({ step: z.enum(STEPS.map((s) => s.id) as [StepId, ...StepId[]]).catch('source').default('source') });

const emptyDraft = (): Draft => ({
  displayName: '',
  slug: '',
  kind: 'mcp_server',
  description: '',
  visibility: { org: false, teamIds: [], userIds: [] },
  risk: 'low',
  autoUpgrade: true,
  spec: defaultSpec(),
});

const fromEntry = (e: CatalogEntryDetail): { draft: Draft; version: CatalogVersion | undefined } => {
  const version = e.versions.find((v) => v.id === e.draftVersionId) ?? e.versions[0];
  return {
    version,
    draft: {
      displayName: e.displayName,
      slug: e.slug,
      kind: e.kind,
      description: e.description,
      visibility: e.visibility,
      risk: e.risk,
      autoUpgrade: e.autoUpgrade,
      spec: version?.spec ?? defaultSpec(),
    },
  };
};

function Editor({ entry }: { entry: CatalogEntryDetail | null }) {
  const navigate = useNavigate();
  const [s, setS] = useSearchState(searchSchema);
  const init = React.useMemo(() => (entry ? fromEntry(entry) : { draft: emptyDraft(), version: undefined }), [entry]);
  const [draft, setDraft] = React.useState<Draft>(init.draft);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const create = useCreateCatalogEntry();
  const version = init.version;
  const publish = usePublish(entry?.id ?? '', version?.id ?? '');
  const test = useTestResult(entry?.id ?? '', version?.id ?? null);
  const change = (d: Draft) => {
    setDraft(d);
    setDirty(true);
  };
  const label = draft.spec.version || version?.label || '0.1.0';
  const passing = !dirty && isPassing(test.data, label);

  const save = async (): Promise<string | null> => {
    if (!draft.displayName.trim()) {
      toast.error('Give the entry a name first');
      setS({ step: 'source' });
      return null;
    }
    setSaving(true);
    try {
      if (!entry) {
        const created = await create.mutateAsync(draft);
        toast.success('Draft saved');
        void navigate({ to: `/catalog/${created.id}`, search: { step: s.step }, replace: true } as never);
        return created.versions[0]?.id ?? null;
      }
      await api.patch(`/catalog/${entry.id}`, {
        displayName: draft.displayName,
        description: draft.description,
        visibility: draft.visibility,
        risk: draft.risk,
        autoUpgrade: draft.autoUpgrade,
      });
      const v = version
        ? await api.patch<CatalogVersion>(`/catalog/${entry.id}/versions/${version.id}`, { spec: draft.spec })
        : await api.post<CatalogVersion>(`/catalog/${entry.id}/versions`, { spec: draft.spec });
      setDirty(false);
      toast.success('Draft saved');
      return v.id;
    } finally {
      setSaving(false);
    }
  };

  const stepIndex = STEPS.findIndex((x) => x.id === s.step);
  const props = { draft, onChange: change };
  return (
    <>
      <PageHeader
        back={{ to: '/catalog', label: 'Catalog' }}
        title={draft.displayName || 'New entry'}
        badge={<Tag tone={entry?.status === 'published' ? 'ok' : 'warn'}>{entry?.status === 'published' ? 'Published' : 'Draft'}</Tag>}
        actions={
          <Button variant="outline" disabled={saving || (!dirty && Boolean(entry))} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save draft'}
          </Button>
        }
      />
      <Stepper steps={[...STEPS]} current={s.step} onSelect={(id) => setS({ step: id as StepId })} label="Catalog steps" />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {s.step === 'source' ? <SourceStep {...props} /> : null}
          {s.step === 'configuration' ? <ConfigurationStep {...props} /> : null}
          {s.step === 'authentication' ? <AuthenticationStep {...props} /> : null}
          {s.step === 'network' ? <NetworkStep {...props} /> : null}
          {s.step === 'overrides' ? <OverridesStep {...props} /> : null}
          {s.step === 'security' ? <SecurityStep {...props} /> : null}
          {s.step === 'test' || s.step === 'publish' ? (
            entry && version ? (
              <TestPanel entryId={entry.id} versionId={version.id} versionLabel={label} canRun onBeforeRun={async () => (dirty ? await save() : version.id)} />
            ) : (
              <div className="rounded-lg bg-surface p-5 shadow-card">
                <p className="m-0 mb-3 text-muted">Save the draft to run its test. The test starts the server as you.</p>
                <Button onClick={() => void save()} disabled={saving}>Save draft</Button>
              </div>
            )
          ) : null}
          <div className="flex justify-between">
            <Button variant="outline" disabled={stepIndex <= 0} onClick={() => setS({ step: STEPS[stepIndex - 1]?.id })}>Back</Button>
            <Button variant="soft" disabled={stepIndex >= STEPS.length - 1} onClick={() => setS({ step: STEPS[stepIndex + 1]?.id })}>Next step</Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <PublishCard
            draft={draft}
            onChange={(p) => change({ ...draft, ...p })}
            versionLabel={label}
            canPublish={passing && Boolean(entry && version)}
            publishing={publish.isPending}
            disabledReason={dirty ? 'Save and test this version to publish it.' : 'Publish needs a passing test of this exact version.'}
            entryId={entry?.id}
            onPublish={() => publish.mutate(undefined, { onSuccess: () => { toast.success(`${draft.displayName} v${label} is in the Store`); void navigate({ to: '/catalog' }); } })}
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
  if (id === 'new') return <Editor key="new" entry={null} />;
  return (
    <QueryBoundary query={q} label="Loading entry">
      {(e) => <Editor key={e.id} entry={e} />}
    </QueryBoundary>
  );
}

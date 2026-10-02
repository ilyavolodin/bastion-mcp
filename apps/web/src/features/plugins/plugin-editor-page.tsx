import { useNavigate, useParams } from '@tanstack/react-router';
import { File, FileCode2, Terminal } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  useCatalogEntry,
  useCatalogFile,
  useCatalogFiles,
  usePublish,
  useSaveFile,
  useTestResult,
} from '@/api/hooks';
import type { CatalogEntryDetail } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { PlainEditor } from '@/components/code-editor';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { MarkdownPreview } from '@/components/markdown-preview';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Stepper } from '@/components/stepper';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  isExecutablePath,
  parseSkill,
  serializeSkill,
  validateFrontmatter,
} from '@/lib/frontmatter';
import { useSearchState } from '@/lib/search';
import { PublishCard } from '../catalog/publish-card';
import { isPassing, TestPanel } from '../catalog/test-panel';

const STEPS = [
  { id: 'files', label: 'Files' },
  { id: 'test', label: 'Test' },
  { id: 'publish', label: 'Publish' },
] as const;
const searchSchema = z.object({
  step: z.enum(['files', 'test', 'publish']).catch('files').default('files'),
});

function SkillForm({
  path,
  content,
  onSave,
}: {
  path: string;
  content: string;
  onSave: (c: string) => void;
}) {
  const parsed = React.useMemo(() => parseSkill(content), [content]);
  const [name, setName] = React.useState(parsed.frontmatter.name);
  const [description, setDescription] = React.useState(parsed.frontmatter.description);
  const [body, setBody] = React.useState(parsed.body);
  React.useEffect(() => {
    setName(parsed.frontmatter.name);
    setDescription(parsed.frontmatter.description);
    setBody(parsed.body);
  }, [parsed]);
  const errors = validateFrontmatter({ ...parsed.frontmatter, name, description });
  const next = serializeSkill({ name, description, extra: parsed.frontmatter.extra }, body);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => e.preventDefault()}
        aria-label={`${path} frontmatter`}
        noValidate
      >
        {parsed.error ? (
          <p role="alert" className="m-0 rounded-md bg-coral-soft p-3 text-[13px] text-coral-ink">
            {parsed.error}
          </p>
        ) : null}
        <Field label="Name" required error={errors.name} help="Lowercase, digits and hyphens">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Description" required error={errors.description}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className="min-h-16"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {Object.keys(parsed.frontmatter.extra).length ? (
          <p className="m-0 text-caption text-muted">
            Kept as written: {Object.keys(parsed.frontmatter.extra).join(', ')}
          </p>
        ) : null}
        <Field label="Instructions (Markdown)">
          {({ id }) => (
            <Textarea
              id={id}
              className="min-h-48 font-mono text-[12px]"
              value={body}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>
        <Button
          className="self-start"
          disabled={Boolean(errors.name || errors.description)}
          onClick={() => onSave(next)}
        >
          Save SKILL.md
        </Button>
      </form>
      <section aria-label="Live preview" className="flex flex-col gap-2 rounded-md bg-sunken p-4">
        <span className="text-overline">Live preview</span>
        <p className="m-0 font-mono text-[12px] text-muted">
          {name || 'name'}: {description || 'description'}
        </p>
        <MarkdownPreview source={body} />
      </section>
    </div>
  );
}

function FilesStep({
  entry,
  versionId,
  readOnly,
}: {
  entry: CatalogEntryDetail;
  versionId: string;
  readOnly: boolean;
}) {
  const files = useCatalogFiles(entry.id, versionId);
  const [selected, setSelected] = React.useState('SKILL.md');
  const file = useCatalogFile(entry.id, versionId, selected);
  const save = useSaveFile(entry.id, versionId);
  const [text, setText] = React.useState('');
  React.useEffect(() => {
    if (file.data) setText(file.data.content);
  }, [file.data]);
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card aria-label="Files" className="gap-2">
        <CardHeader title="Files" />
        <QueryBoundary query={files}>
          {(nodes) => (
            <>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {nodes.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      aria-pressed={selected === f.path}
                      onClick={() => setSelected(f.path)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left font-mono text-[12px]',
                        selected === f.path
                          ? 'bg-tangerine-soft text-tangerine-ink'
                          : 'hover:bg-sunken',
                        f.classification === 'executable' &&
                          selected !== f.path &&
                          'bg-coral-soft/60',
                      )}
                    >
                      {f.classification === 'executable' ? (
                        <Terminal className="size-3.5 text-coral-ink" aria-hidden="true" />
                      ) : f.path.endsWith('.md') ? (
                        <FileCode2 className="size-3.5 text-muted" aria-hidden="true" />
                      ) : (
                        <File className="size-3.5 text-muted" aria-hidden="true" />
                      )}
                      <span className="flex-1 truncate">{f.path}</span>
                      {f.classification === 'executable' ? (
                        <span className="text-[10px] font-semibold text-coral-ink">runs code</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              {nodes.some((n) => n.classification === 'executable') ? (
                <div role="note" className="rounded-md bg-coral-soft p-3 text-[13px]">
                  <strong className="font-semibold text-coral-ink">Executable content</strong>
                  <ul className="m-0 mt-1 list-disc pl-4 font-mono text-[12px]">
                    {nodes
                      .filter((n) => n.classification === 'executable')
                      .map((n) => (
                        <li key={n.path}>{n.path}</li>
                      ))}
                  </ul>
                  <p className="m-0 mt-1.5 text-caption">
                    An Admin approves these with the diff before the version publishes.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </QueryBoundary>
      </Card>
      <Card aria-label={selected} className="min-w-0 gap-3">
        <CardHeader
          title={selected}
          actions={isExecutablePath(selected) ? <Tag tone="bad">Runs code locally</Tag> : undefined}
        />
        {file.isPending ? (
          <p className="m-0 text-muted">Loading…</p>
        ) : selected === 'SKILL.md' && file.data ? (
          <SkillForm
            path={selected}
            content={file.data.content}
            onSave={(c) =>
              save.mutate(
                { path: selected, content: c },
                { onSuccess: () => toast.success('SKILL.md saved') },
              )
            }
          />
        ) : (
          <>
            <PlainEditor
              language="json"
              ariaLabel={`Contents of ${selected}`}
              value={text}
              readOnly={readOnly}
              height={280}
              onChange={setText}
            />
            <Button
              className="self-start"
              disabled={readOnly || save.isPending}
              onClick={() =>
                save.mutate(
                  { path: selected, content: text },
                  { onSuccess: () => toast.success(`${selected} saved`) },
                )
              }
            >
              Save file
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

function Editor({ entry }: { entry: CatalogEntryDetail }) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [s, setS] = useSearchState(searchSchema);
  const version = entry.versions.find((v) => v.id === entry.draftVersionId) ?? entry.versions[0];
  const publish = usePublish(entry.id, version?.id ?? '');
  const test = useTestResult(entry.id, version?.id ?? null);
  const [vis, setVis] = React.useState({
    visibility: entry.visibility,
    risk: entry.risk,
    autoUpgrade: entry.autoUpgrade,
  });
  const label = version?.label ?? '0.1.0';
  const needsApproval = version?.executableApproval === 'pending' || entry.executable;
  if (!version)
    return (
      <EmptyState
        title="This entry has no version yet"
        action={{ label: 'Back to Plugins', to: '/plugins' }}
      />
    );
  return (
    <>
      <PageHeader
        back={{ to: '/plugins', label: 'Plugins' }}
        title={entry.displayName}
        badge={
          <Tag tone={entry.status === 'published' ? 'ok' : 'warn'}>
            {entry.status === 'published' ? 'Published' : 'Draft'}
          </Tag>
        }
      />
      <Stepper
        steps={[...STEPS]}
        current={s.step}
        onSelect={(id) => setS({ step: id as (typeof s)['step'] })}
        label="Plugin steps"
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {s.step === 'files' ? (
            <FilesStep entry={entry} versionId={version.id} readOnly={false} />
          ) : null}
          {s.step !== 'files' ? (
            <TestPanel entryId={entry.id} versionId={version.id} versionLabel={label} canRun />
          ) : null}
        </div>
        <PublishCard
          draft={vis}
          onChange={(p) => setVis({ ...vis, ...p })}
          versionLabel={label}
          noun={'v'}
          canPublish={isPassing(test.data, label)}
          publishing={publish.isPending}
          disabledReason="Publish needs a passing test of this exact version."
          entryId={entry.id}
          onPublish={() =>
            publish.mutate(undefined, {
              onSuccess: () => {
                toast.success(
                  needsApproval && role !== 'admin'
                    ? 'Sent to an Admin for approval with the diff'
                    : `${entry.displayName} v${label} published`,
                );
                void navigate({ to: '/plugins' });
              },
            })
          }
        />
      </div>
    </>
  );
}

export function PluginEditorPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useCatalogEntry(id === 'new' ? undefined : id);
  if (id === 'new') {
    return (
      <>
        <PageHeader back={{ to: '/plugins', label: 'Plugins' }} title="Author a plugin" />
        <EmptyState
          title="Start from an existing plugin"
          description="Open a plugin from the Catalog to edit its files, or import one by URL."
          action={{ label: 'Open the Catalog', to: '/catalog', search: { kind: 'plugins' } }}
        />
      </>
    );
  }
  return <QueryBoundary query={q}>{(e) => <Editor key={e.id} entry={e} />}</QueryBoundary>;
}

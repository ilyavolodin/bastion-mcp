import * as React from 'react';
import { toast } from 'sonner';
import { useOverrides, usePreviewOverrides, useSaveOverrides } from '@/api/hooks';
import { toDefinitionPairs } from '@/api/views/servers';
import { CodeEditor } from '@/components/code-editor';
import { DiffView } from '@/components/diff-view';
import { Card, CardHeader, ReadOnlyNote, Segmented, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { stableStringify } from '@/lib/diff';
import {
  type OverrideDocument,
  overrideJsonSchema,
  sectionOf,
  setItemField,
  validateOverrideText,
} from '@/lib/override-schema';
import { OverrideForm } from './override-form';
import { TryIt } from './try-it';

function Editor({
  installationId,
  initial,
  canEdit,
  rejected,
}: {
  installationId: string;
  initial: OverrideDocument;
  canEdit: boolean;
  rejected: { path: string; reason: string }[];
}) {
  const [doc, setDoc] = React.useState<OverrideDocument>(initial);
  const [saved, setSaved] = React.useState<OverrideDocument>(initial);
  const [view, setView] = React.useState<'editor' | 'json'>('editor');
  const [raw, setRaw] = React.useState(() => JSON.stringify(initial, null, 2));
  const [selected, setSelected] = React.useState<string | null>(null);
  const preview = usePreviewOverrides();
  const save = useSaveOverrides(installationId);
  const schema = React.useMemo(() => overrideJsonSchema(), []);
  const validation = validateOverrideText(raw);
  const dirty = stableStringify(doc) !== stableStringify(saved);

  // Recompute the final definitions shortly after every edit.
  const { mutate: runPreview } = preview;
  React.useEffect(() => {
    const t = setTimeout(() => runPreview({ installationId, document: doc }), 250);
    return () => clearTimeout(t);
  }, [doc, installationId, runPreview]);

  const defs = React.useMemo(
    () => (preview.data ? toDefinitionPairs(preview.data) : []),
    [preview.data],
  );
  const current = defs.find((d) => d.name === selected) ?? defs[0];
  const entry = current ? (doc[sectionOf(current.kind)]?.[current.name] ?? {}) : {};

  const onForm = (field: string, value: unknown) => {
    if (!current) return;
    const next = setItemField(doc, sectionOf(current.kind), current.name, field, value);
    setDoc(next);
    setRaw(JSON.stringify(next, null, 2));
  };
  const onRaw = (text: string) => {
    setRaw(text);
    const v = validateOverrideText(text);
    if (v.ok) setDoc(v.document);
  };

  return (
    <div className="flex flex-col gap-6">
      {!canEdit ? (
        <ReadOnlyNote>You can look at the overrides but not change them.</ReadOnlyNote>
      ) : null}
      <Card aria-label="Overrides editor" className="gap-4">
        <CardHeader
          title="Overrides"
          subtitle="What your AI tools see instead of the upstream definition"
          actions={
            <>
              <Segmented
                label="Editor view"
                value={view}
                onChange={(v) => {
                  if (v === 'json') setRaw(JSON.stringify(doc, null, 2));
                  setView(v);
                }}
                options={[
                  { value: 'editor', label: 'Form' },
                  { value: 'json', label: 'Raw JSON' },
                ]}
              />
              {dirty ? <Tag tone="warn">Unsaved changes</Tag> : null}
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty}
                onClick={() => {
                  setDoc(saved);
                  setRaw(JSON.stringify(saved, null, 2));
                }}
              >
                Revert
              </Button>
              <Button
                size="sm"
                disabled={
                  !canEdit || !dirty || save.isPending || (view === 'json' && !validation.ok)
                }
                onClick={() =>
                  save.mutate(doc, {
                    onSuccess: () => {
                      setSaved(doc);
                      toast.success('Overrides saved');
                    },
                  })
                }
              >
                {save.isPending ? 'Saving…' : 'Save overrides'}
              </Button>
            </>
          }
        />
        {[...rejected, ...(preview.data?.rejected ?? [])].length ? (
          <ul
            role="alert"
            className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
          >
            {[...rejected, ...(preview.data?.rejected ?? [])].map((r) => (
              <li key={`${r.path}-${r.reason}`}>
                {r.path}: {r.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {preview.isError ? <ProblemAlert error={preview.error} /> : null}
        {view === 'json' ? (
          <div className="flex flex-col gap-3">
            <CodeEditor
              language="json"
              ariaLabel="Override document JSON"
              value={raw}
              onChange={canEdit ? onRaw : undefined}
              readOnly={!canEdit}
              jsonSchema={schema}
              height={360}
            />
            {validation.ok ? (
              <p className="m-0 text-caption font-medium text-mint-ink">Valid override document.</p>
            ) : (
              <ul
                role="alert"
                aria-label="Validation errors"
                className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
              >
                {validation.issues.map((i) => (
                  <li key={`${i.path}-${i.message}`}>
                    {i.path ? `${i.path}: ` : ''}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
            <ul aria-label="Items" className="m-0 flex list-none flex-col gap-1 p-0">
              {defs.map((d) => {
                const on = d.name === (current?.name ?? '');
                const touched = Boolean(doc[sectionOf(d.kind)]?.[d.name]);
                return (
                  <li key={`${d.kind}-${d.name}`}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSelected(d.name)}
                      className={cn(
                        'flex h-10 w-full items-center gap-2 rounded-md px-3 text-left font-mono text-[13px]',
                        on ? 'bg-tangerine-soft text-tangerine-ink' : 'hover:bg-sunken',
                      )}
                    >
                      <span className="flex-1 truncate">{d.name}</span>
                      {touched ? (
                        <span className="size-2 rounded-full bg-tangerine" title="Overridden" />
                      ) : null}
                      {d.hidden ? <span className="sr-only">hidden</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {current ? (
              <div className="flex min-w-0 flex-col gap-5">
                {current.final === null ? (
                  <p className="m-0 rounded-md bg-sunken p-3 text-muted">
                    {current.error
                      ? `Not served: ${current.error}`
                      : 'Hidden. This item is not served to AI tools.'}
                  </p>
                ) : null}
                <DiffView
                  mode="lines"
                  leftLabel="Upstream definition"
                  rightLabel="Final definition"
                  left={
                    current.upstream
                      ? stableStringify(current.upstream)
                      : '(the definition is withheld while the item is hidden)'
                  }
                  right={current.final ? stableStringify(current.final) : '(hidden)'}
                />
                <OverrideForm
                  kind={current.kind}
                  entry={entry as Record<string, unknown>}
                  disabled={!canEdit}
                  onChange={onForm}
                />
              </div>
            ) : (
              <p className="m-0 text-muted">Waiting for the server’s definitions…</p>
            )}
          </div>
        )}
      </Card>
      <TryIt installationId={installationId} defs={defs} />
    </div>
  );
}

/** The stored document, or an empty one (the API stores `{}` until the first save). */
const asDocument = (doc: Record<string, unknown>): OverrideDocument => {
  const parsed = validateOverrideText(JSON.stringify({ version: 1, ...doc }));
  return parsed.ok ? parsed.document : { version: 1 };
};

/** Override editor (12.5): diff, form controls, raw JSON with schema validation, and a Try-it panel. */
export function OverridesTab({ installationId }: { installationId: string }) {
  const q = useOverrides(installationId);
  return (
    <QueryBoundary query={q}>
      {(d) => (
        <Editor
          installationId={installationId}
          initial={asDocument(d.doc)}
          canEdit={d.userOverrides !== 'none'}
          rejected={d.rejected}
        />
      )}
    </QueryBoundary>
  );
}

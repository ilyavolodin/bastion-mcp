import * as React from 'react';
import { toast } from 'sonner';
import { useOverrides, usePreviewOverrides, useSaveOverrides } from '@/api/hooks';
import { toDefinitionPairs } from '@/api/views/servers';
import { CodeEditor } from '@/components/code-editor';
import { Card, CardHeader, ReadOnlyNote, Segmented, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { stableStringify } from '@/lib/diff';
import {
  type OverrideDocument,
  overrideJsonSchema,
  validateOverrideText,
} from '@/lib/override-schema';
import { ItemsList } from './items-list';
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
          subtitle="Choose which tools, prompts and resources your AI tools see; customize the few that need it"
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
                  { value: 'editor', label: 'Items' },
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
          <ItemsList
            defs={defs}
            doc={doc}
            canEdit={canEdit}
            onChange={(next) => {
              setDoc(next);
              setRaw(JSON.stringify(next, null, 2));
            }}
          />
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

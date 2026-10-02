import { Play } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useOverrides, usePreviewOverrides, useSaveOverrides, useTryTool } from '@/api/hooks';
import type { DefinitionPair, OverrideDocument } from '@/api/types';
import { CodeEditor } from '@/components/code-editor';
import { DiffView } from '@/components/diff-view';
import { Field } from '@/components/form';
import { Card, CardHeader, ReadOnlyNote, Segmented, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { stableStringify } from '@/lib/diff';
import {
  overrideJsonSchema,
  sectionOf,
  setItemField,
  validateOverrideText,
} from '@/lib/override-schema';
import { OverrideForm } from './override-form';

function TryIt({ installationId, tools }: { installationId: string; tools: DefinitionPair[] }) {
  const run = useTryTool(installationId);
  const [tool, setTool] = React.useState(tools[0]?.name ?? '');
  const [args, setArgs] = React.useState('{\n  "query": "orders"\n}');
  const [argError, setArgError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!tool && tools[0]) setTool(tools[0].name);
  }, [tools, tool]);
  const result = run.data;
  return (
    <Card aria-label="Try it" className="gap-3.5">
      <CardHeader
        title="Try it"
        subtitle="Calls the tool through the final definition, with all guards"
      />
      <div className="grid gap-4 sm:grid-cols-[240px_minmax(0,1fr)]">
        <Field label="Tool">
          {({ id }) => (
            <Select id={id} value={tool} onChange={(e) => setTool(e.target.value)}>
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {String((t.final?.name as string | undefined) ?? t.name)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Arguments (JSON)" error={argError ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="min-h-20 font-mono text-[12px]"
              spellCheck={false}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={run.isPending || !tool}
          onClick={() => {
            try {
              const parsed = JSON.parse(args) as Record<string, unknown>;
              setArgError(null);
              run.mutate({ name: tool, arguments: parsed });
            } catch (e) {
              setArgError(e instanceof Error ? e.message : 'Invalid JSON');
            }
          }}
        >
          <Play className="size-4" aria-hidden="true" />
          {run.isPending ? 'Running…' : 'Run'}
        </Button>
        {result ? (
          <>
            <Tag tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'Succeeded' : 'Blocked'}</Tag>
            <span className="text-caption text-muted">{result.durationMs} ms</span>
            {result.guard ? <Tag tone="info">{result.guard}</Tag> : null}
          </>
        ) : null}
      </div>
      {result ? (
        <pre
          role="group"
          aria-label="Result"
          className="m-0 max-h-60 overflow-auto rounded-md bg-sunken p-3 font-mono text-[12px]"
        >
          {result.text}
        </pre>
      ) : null}
      {run.isError ? <ProblemAlert error={run.error} /> : null}
    </Card>
  );
}

function Editor({
  installationId,
  initial,
  canEdit,
}: {
  installationId: string;
  initial: OverrideDocument;
  canEdit: boolean;
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

  const defs = preview.data?.definitions ?? [];
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
        {preview.data?.errors.length ? (
          <ul
            role="alert"
            className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
          >
            {preview.data.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
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
                      {d.final === null ? <span className="sr-only">hidden</span> : null}
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
                  left={stableStringify(current.upstream)}
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
      <TryIt
        installationId={installationId}
        tools={defs.filter((d) => d.kind === 'tool' && d.final !== null)}
      />
    </div>
  );
}

/** Override editor (12.5): diff, form controls, raw JSON with schema validation, and a Try-it panel. */
export function OverridesTab({ installationId }: { installationId: string }) {
  const q = useOverrides(installationId);
  return (
    <QueryBoundary query={q}>
      {(d) => <Editor installationId={installationId} initial={d.document} canEdit={d.canEdit} />}
    </QueryBoundary>
  );
}

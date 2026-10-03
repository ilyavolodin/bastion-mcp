import { Play } from 'lucide-react';
import * as React from 'react';
import { useTry } from '@/api/hooks';
import type { DefinitionPair } from '@/api/views/servers';
import { CodeEditor } from '@/components/code-editor';
import { Field } from '@/components/form';
import { Card, CardHeader, Segmented, Tag } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { isRecord } from '@/lib/json';
import {
  expandTemplate,
  hasParameters,
  initialArguments,
  type JsonSchema,
  missingRequired,
  templateVariables,
  unknownArguments,
} from '@/lib/json-schema-form';
import { SchemaForm } from './schema-form';

type Args = Record<string, unknown>;
type TryKind = 'tool' | 'prompt' | 'resource';

const KIND_LABEL: Record<TryKind, string> = {
  tool: 'Tool',
  prompt: 'Prompt',
  resource: 'Resource',
};

/** The name AI tools use: the override's name, else the upstream one. */
const finalName = (d: DefinitionPair): string =>
  typeof d.final?.name === 'string' ? d.final.name : d.name;

const served = (defs: DefinitionPair[], kinds: DefinitionPair['kind'][]) =>
  defs.filter((d) => kinds.includes(d.kind) && d.final !== null);

type PromptArgument = { name: string; description?: string; required?: boolean };

const promptArguments = (d: DefinitionPair | undefined): PromptArgument[] => {
  const declared = d?.final?.arguments;
  return Array.isArray(declared)
    ? declared.filter((a): a is PromptArgument => isRecord(a) && typeof a.name === 'string')
    : [];
};

const CUSTOM_URI = '__custom__';

/** What a call answered, in the form of what it is: text blocks, prompt messages, resource contents. */
function ResultView({ kind, result }: { kind: TryKind; result: unknown }) {
  const body = isRecord(result) ? result : {};
  const blocks: { key: string; label: string; text: string }[] = [];
  // A refusal (policy, a guard, limits, an unknown name) is a legitimate answer of a try: say it in words.
  if (isRecord(body.error)) {
    blocks.push({
      key: 'error',
      label: typeof body.error.code === 'string' ? body.error.code : 'Error',
      text:
        typeof body.error.message === 'string' ? body.error.message : JSON.stringify(body.error),
    });
  } else if (typeof body.error === 'string') {
    blocks.push({ key: 'error', label: 'Error', text: body.error });
  }
  if (kind === 'tool' && Array.isArray(body.content)) {
    body.content.forEach((c, i) => {
      if (isRecord(c) && c.type === 'text' && typeof c.text === 'string') {
        blocks.push({ key: `c${i}`, label: 'Text', text: c.text });
      } else if (isRecord(c)) {
        blocks.push({
          key: `c${i}`,
          label: String(c.type ?? 'Content'),
          text: JSON.stringify(c, null, 2),
        });
      }
    });
    if (body.structuredContent !== undefined) {
      blocks.push({
        key: 'structured',
        label: 'Structured',
        text: JSON.stringify(body.structuredContent, null, 2),
      });
    }
  }
  if (kind === 'prompt' && Array.isArray(body.messages)) {
    body.messages.forEach((m, i) => {
      if (!isRecord(m)) return;
      const content = isRecord(m.content) ? m.content : {};
      blocks.push({
        key: `m${i}`,
        label: String(m.role ?? 'message'),
        text: typeof content.text === 'string' ? content.text : JSON.stringify(m.content, null, 2),
      });
    });
  }
  if (kind === 'resource' && Array.isArray(body.contents)) {
    body.contents.forEach((c, i) => {
      if (!isRecord(c)) return;
      const label = `${String(c.uri ?? 'resource')}${typeof c.mimeType === 'string' ? ` · ${c.mimeType}` : ''}`;
      blocks.push({
        key: `r${i}`,
        label,
        text:
          typeof c.text === 'string'
            ? c.text
            : typeof c.blob === 'string'
              ? `(${c.blob.length} characters of base64 data)`
              : JSON.stringify(c, null, 2),
      });
    });
  }
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Result">
      {blocks.map((b) => (
        <div key={b.key} className="rounded-md bg-sunken">
          <div className="border-b border-line px-3 py-1.5 text-caption font-medium text-muted">
            {b.label}
          </div>
          <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px]">
            {b.text}
          </pre>
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-caption text-muted">Raw response</summary>
        <pre className="m-0 mt-2 max-h-60 overflow-auto rounded-md bg-sunken p-3 font-mono text-[12px]">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Try it (12.5): calls a tool, gets a prompt or reads a resource through the final definitions, with all guards, as the
 * signed-in person. The arguments come from what the definition itself declares: a tool's input schema gives a form
 * (and, as JSON, completion and validation), a prompt lists its arguments, a template its variables.
 */
export function TryIt({
  installationId,
  defs,
}: {
  installationId: string;
  defs: DefinitionPair[];
}) {
  const run = useTry(installationId);
  const tools = served(defs, ['tool']);
  const prompts = served(defs, ['prompt']);
  const resources = served(defs, ['resource', 'template']);
  const available: Record<TryKind, DefinitionPair[]> = {
    tool: tools,
    prompt: prompts,
    resource: resources,
  };
  const firstKind = (['tool', 'prompt', 'resource'] as const).find((k) => available[k].length > 0);
  const [kind, setKind] = React.useState<TryKind>(firstKind ?? 'tool');
  const items = available[kind];
  const [chosen, setChosen] = React.useState<string>('');
  const item =
    items.find((d) => (kind === 'resource' ? d.name : finalName(d)) === chosen) ?? items[0];

  const [args, setArgs] = React.useState<Args>({});
  const [promptValues, setPromptValues] = React.useState<Record<string, string>>({});
  const [templateValues, setTemplateValues] = React.useState<Record<string, string>>({});
  const [customUri, setCustomUri] = React.useState('');
  const [mode, setMode] = React.useState<'form' | 'json'>('form');
  const [text, setText] = React.useState('{}');
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);

  // Nothing is chosen until the definitions arrive; once they do, the first item of the first kind is.
  React.useEffect(() => {
    if (items.length === 0 && firstKind && firstKind !== kind) setKind(firstKind);
  }, [items.length, firstKind, kind]);

  const schema = (
    kind === 'tool' && isRecord(item?.final?.inputSchema) ? item?.final?.inputSchema : undefined
  ) as JsonSchema | undefined;
  const itemKey = `${kind}:${item ? (kind === 'resource' ? item.name : finalName(item)) : ''}`;

  // A different item starts from what its own definition suggests, never from the previous item's values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the chosen item changes
  React.useEffect(() => {
    const start = initialArguments(schema);
    setArgs(start);
    setText(JSON.stringify(start, null, 2));
    setParseError(null);
    setProblems([]);
    setPromptValues({});
    setTemplateValues({});
    run.reset();
  }, [itemKey]);

  const changeArgs = (next: Args) => {
    setArgs(next);
    setText(JSON.stringify(next, null, 2));
    setParseError(null);
  };
  const changeText = (t: string) => {
    setText(t);
    try {
      const parsed = JSON.parse(t);
      if (!isRecord(parsed)) throw new Error('The arguments must be a JSON object');
      setArgs(parsed);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Not valid JSON');
    }
  };

  const isTemplate = kind === 'resource' && item?.kind === 'template';
  const template = isTemplate ? String(item?.final?.uriTemplate ?? item?.name ?? '') : '';
  const uri =
    chosen === CUSTOM_URI
      ? customUri
      : isTemplate
        ? expandTemplate(template, templateValues)
        : typeof item?.final?.uri === 'string'
          ? item.final.uri
          : (item?.name ?? '');
  const promptArgs = kind === 'prompt' ? promptArguments(item) : [];

  const start = () => {
    setProblems([]);
    if (kind === 'tool') {
      if (!item) return;
      if (mode === 'json' && parseError) return;
      const missing = missingRequired(schema, args);
      if (missing.length > 0) return setProblems(missing.map((m) => m.message));
      run.mutate({ kind: 'tool', name: finalName(item), arguments: args });
    } else if (kind === 'prompt') {
      if (!item) return;
      const missing = promptArgs.filter((a) => a.required && !(promptValues[a.name] ?? '').trim());
      if (missing.length > 0) return setProblems(missing.map((a) => `${a.name} is required`));
      const given = Object.fromEntries(Object.entries(promptValues).filter(([, v]) => v !== ''));
      run.mutate({ kind: 'prompt', name: finalName(item), arguments: given });
    } else {
      if (!uri.trim()) return setProblems(['Give the URI of the resource to read']);
      run.mutate({ kind: 'resource', uri });
    }
  };

  const result = run.data;
  const empty = items.length === 0;
  const unknown = kind === 'tool' && mode === 'json' ? unknownArguments(schema, args) : [];
  return (
    <Card aria-label="Try it" className="gap-3.5">
      <CardHeader
        title="Try it"
        subtitle="Runs through the final definitions, with all guards, as you"
        actions={
          <Segmented
            label="What to try"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setChosen('');
            }}
            options={(['tool', 'prompt', 'resource'] as const).map((k) => ({
              value: k,
              label: `${KIND_LABEL[k]}s (${available[k].length})`,
            }))}
          />
        }
      />
      {empty ? (
        <p className="m-0 text-muted">
          This server offers no {KIND_LABEL[kind].toLowerCase()}s that are shown to AI tools.
        </p>
      ) : (
        <>
          <Field label={KIND_LABEL[kind]}>
            {({ id }) => (
              <Select
                id={id}
                value={
                  chosen === CUSTOM_URI
                    ? CUSTOM_URI
                    : item
                      ? kind === 'resource'
                        ? item.name
                        : finalName(item)
                      : ''
                }
                onChange={(e) => setChosen(e.target.value)}
              >
                {items.map((d) => {
                  const key = kind === 'resource' ? d.name : finalName(d);
                  return (
                    <option key={`${d.kind}-${key}`} value={key}>
                      {d.kind === 'template' ? `Template: ${key}` : key}
                    </option>
                  );
                })}
                {kind === 'resource' ? (
                  <option value={CUSTOM_URI}>A URI of your own…</option>
                ) : null}
              </Select>
            )}
          </Field>
          {item && typeof item.final?.description === 'string' && item.final.description ? (
            <p className="m-0 text-caption text-muted">{item.final.description}</p>
          ) : null}

          {kind === 'tool' ? (
            <div className="flex flex-col gap-3">
              <Segmented
                label="Arguments"
                value={mode}
                onChange={(m) => {
                  if (m === 'json') setText(JSON.stringify(args, null, 2));
                  setMode(m);
                }}
                options={[
                  { value: 'form', label: 'Form' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
              {mode === 'form' ? (
                hasParameters(schema) ? (
                  <SchemaForm schema={schema} value={args} onChange={changeArgs} />
                ) : (
                  <p className="m-0 text-muted">This tool takes no arguments.</p>
                )
              ) : (
                <div className="flex flex-col gap-2">
                  <CodeEditor
                    language="json"
                    ariaLabel="Arguments (JSON)"
                    value={text}
                    onChange={changeText}
                    {...(schema ? { jsonSchema: schema as Record<string, unknown> } : {})}
                    height={200}
                  />
                  {parseError ? (
                    <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
                      {parseError}
                    </p>
                  ) : null}
                  {unknown.length > 0 ? (
                    <p role="note" className="m-0 text-caption text-muted">
                      The tool does not declare {unknown.map((u) => `“${u}”`).join(', ')}.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {kind === 'prompt' ? (
            promptArgs.length > 0 ? (
              <div className="flex flex-col gap-3.5">
                {promptArgs.map((a) => (
                  <Field
                    key={a.name}
                    label={`${a.name}${a.required ? ' *' : ''}`}
                    help={a.description}
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        autoComplete="off"
                        value={promptValues[a.name] ?? ''}
                        onChange={(e) =>
                          setPromptValues({ ...promptValues, [a.name]: e.target.value })
                        }
                      />
                    )}
                  </Field>
                ))}
              </div>
            ) : (
              <p className="m-0 text-muted">This prompt takes no arguments.</p>
            )
          ) : null}

          {kind === 'resource' ? (
            <div className="flex flex-col gap-3.5">
              {chosen === CUSTOM_URI ? (
                <Field label="URI">
                  {({ id }) => (
                    <Input
                      id={id}
                      autoComplete="off"
                      value={customUri}
                      onChange={(e) => setCustomUri(e.target.value)}
                    />
                  )}
                </Field>
              ) : isTemplate ? (
                templateVariables(template).map((v) => (
                  <Field key={v} label={v}>
                    {({ id }) => (
                      <Input
                        id={id}
                        autoComplete="off"
                        value={templateValues[v] ?? ''}
                        onChange={(e) =>
                          setTemplateValues({ ...templateValues, [v]: e.target.value })
                        }
                      />
                    )}
                  </Field>
                ))
              ) : null}
              <p className="m-0 break-all font-mono text-[12px] text-muted">
                <span className="sr-only">URI to read: </span>
                {uri || '(no URI yet)'}
              </p>
            </div>
          ) : null}
        </>
      )}
      {problems.length > 0 ? (
        <ul
          role="alert"
          className="m-0 list-disc rounded-md bg-coral-soft py-2.5 pl-8 pr-3 text-[13px] text-coral-ink"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={run.isPending || empty} onClick={start}>
          <Play className="size-4" aria-hidden="true" />
          {run.isPending
            ? 'Running…'
            : kind === 'tool'
              ? 'Run'
              : kind === 'prompt'
                ? 'Get prompt'
                : 'Read'}
        </Button>
        {result ? (
          <>
            <Tag tone={result.isError ? 'bad' : 'ok'}>
              {result.isError ? 'Failed' : 'Succeeded'}
            </Tag>
            <span className="text-caption text-muted">{result.durationMs} ms</span>
          </>
        ) : null}
      </div>
      {result ? <ResultView kind={kind} result={result.result} /> : null}
      {run.isError ? <ProblemAlert error={run.error} /> : null}
    </Card>
  );
}

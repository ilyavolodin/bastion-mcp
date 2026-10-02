import * as React from 'react';
import type { ItemKind } from '@/api/types';
import { Field } from '@/components/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

type Entry = Record<string, unknown>;
type Props = {
  kind: ItemKind;
  entry: Entry;
  disabled?: boolean;
  onChange: (field: string, value: unknown) => void;
};

/** A JSON-valued field edited as text; invalid JSON is flagged and not written. */
function JsonField({
  label,
  help,
  value,
  expect,
  disabled,
  onValid,
}: {
  label: string;
  help?: string;
  value: unknown;
  expect: 'object' | 'array';
  disabled?: boolean | undefined;
  onValid: (v: unknown) => void;
}) {
  const [text, setText] = React.useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = React.useState<string | undefined>();
  const last = React.useRef(value);
  React.useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(last.current)) {
      setText(value === undefined ? '' : JSON.stringify(value, null, 2));
      last.current = value;
    }
  }, [value]);
  return (
    <Field label={label} help={help} error={error}>
      {({ id, describedBy, invalid }) => (
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          disabled={disabled}
          value={text}
          spellCheck={false}
          className="min-h-16 font-mono text-[12px]"
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            if (t.trim() === '') {
              setError(undefined);
              last.current = undefined;
              onValid(undefined);
              return;
            }
            try {
              const v = JSON.parse(t);
              const ok = expect === 'array' ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v);
              if (!ok) throw new Error(`Expected a JSON ${expect}`);
              setError(undefined);
              last.current = v;
              onValid(v);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Invalid JSON');
            }
          }}
        />
      )}
    </Field>
  );
}

const TRI = [
  ['readOnlyHint', 'Read-only hint'],
  ['destructiveHint', 'Destructive hint'],
  ['idempotentHint', 'Idempotent hint'],
  ['openWorldHint', 'Open-world hint'],
] as const;

const csv = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');
const parseCsv = (t: string): string[] | undefined => {
  const parts = t.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
};

/** Form controls for every field of the override document for one item (12.2, 12.5). */
export function OverrideForm({ kind, entry, disabled, onChange }: Props) {
  const desc = entry.description;
  const mode = typeof desc === 'string' ? 'replace' : desc && typeof desc === 'object' ? String((desc as { mode: string }).mode) : '';
  const text = typeof desc === 'string' ? desc : desc && typeof desc === 'object' ? String((desc as { text: string }).text) : '';
  const setDescription = (m: string, t: string) => {
    if (!m || !t) return onChange('description', undefined);
    onChange('description', m === 'replace' ? t : { mode: m, text: t });
  };
  const annotations = (entry.annotations ?? {}) as Record<string, unknown>;
  const outputTransform = (entry.outputTransform ?? {}) as { maxTextBytes?: number; dropContentTypes?: string[] };
  const meta = (entry.meta ?? {}) as { remove?: string[] };
  const isTool = kind === 'tool';
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()} aria-label="Override fields">
      <label className="flex items-center gap-3">
        <Switch disabled={disabled} checked={entry.hidden === true} onCheckedChange={(v) => onChange('hidden', v ? true : undefined)} />
        <span className="text-label">Hide from AI tools</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {kind !== 'resource' && kind !== 'template' ? (
          <Field label="Name" help="Exact final name; suppresses prefixing">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} disabled={disabled} value={String(entry.name ?? '')} onChange={(e) => onChange('name', e.target.value)} />
            )}
          </Field>
        ) : null}
        <Field label="Title">
          {({ id }) => <Input id={id} disabled={disabled} value={String(entry.title ?? '')} onChange={(e) => onChange('title', e.target.value)} />}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="Description">
          {({ id }) => (
            <Select id={id} disabled={disabled} value={mode} onChange={(e) => setDescription(e.target.value, text)}>
              <option value="">Unchanged</option>
              <option value="replace">Replace</option>
              <option value="append">Append</option>
              <option value="prepend">Prepend</option>
            </Select>
          )}
        </Field>
        <Field label="Description text">
          {({ id }) => <Textarea id={id} disabled={disabled || !mode} value={text} onChange={(e) => setDescription(mode || 'replace', e.target.value)} className="min-h-16" />}
        </Field>
      </div>
      {isTool ? (
        <>
          <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
            <legend className="mb-1.5 text-[13px] font-medium">Annotations</legend>
            {TRI.map(([key, label]) => (
              <Field key={key} label={label}>
                {({ id }) => (
                  <Select
                    id={id}
                    disabled={disabled}
                    value={annotations[key] === undefined ? '' : String(annotations[key])}
                    onChange={(e) => {
                      const v = e.target.value;
                      const next = { ...annotations };
                      if (v === '') delete next[key];
                      else next[key] = v === 'true';
                      onChange('annotations', Object.keys(next).length ? next : undefined);
                    }}
                  >
                    <option value="">Unchanged</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </Select>
                )}
              </Field>
            ))}
          </fieldset>
          <JsonField label="Pinned arguments" help="Removed from the schema and set on every call" value={entry.pinnedArguments} expect="object" disabled={disabled} onValid={(v) => onChange('pinnedArguments', v)} />
          <JsonField label="Default arguments" help="Shown as schema defaults and filled when omitted" value={entry.defaultArguments} expect="object" disabled={disabled} onValid={(v) => onChange('defaultArguments', v)} />
          <JsonField label="Input schema patch" help="RFC 6902 JSON Patch applied after pinning" value={entry.inputSchemaPatch} expect="array" disabled={disabled} onValid={(v) => onChange('inputSchemaPatch', v)} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max text bytes">
              {({ id }) => (
                <Input id={id} type="number" min={1} disabled={disabled} value={outputTransform.maxTextBytes ?? ''}
                  onChange={(e) => {
                    const n = e.target.value === '' ? undefined : Number(e.target.value);
                    const next = { ...outputTransform, ...(n !== undefined ? { maxTextBytes: n } : {}) };
                    if (n === undefined) delete next.maxTextBytes;
                    onChange('outputTransform', Object.keys(next).length ? next : undefined);
                  }} />
              )}
            </Field>
            <Field label="Drop content types" help="Comma separated">
              {({ id }) => (
                <Input id={id} disabled={disabled} defaultValue={csv(outputTransform.dropContentTypes)}
                  onBlur={(e) => {
                    const list = parseCsv(e.target.value);
                    const next = { ...outputTransform };
                    if (list) next.dropContentTypes = list;
                    else delete next.dropContentTypes;
                    onChange('outputTransform', Object.keys(next).length ? next : undefined);
                  }} />
              )}
            </Field>
            <Field label="Timeout (ms)">
              {({ id }) => (
                <Input id={id} type="number" min={1} disabled={disabled} value={String(entry.timeoutMs ?? '')} onChange={(e) => onChange('timeoutMs', e.target.value === '' ? undefined : Number(e.target.value))} />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Remove _meta keys" help="Comma separated">
              {({ id }) => (
                <Input id={id} disabled={disabled} defaultValue={csv(meta.remove)} onBlur={(e) => {
                  const list = parseCsv(e.target.value);
                  onChange('meta', list ? { ...meta, remove: list } : undefined);
                }} />
              )}
            </Field>
            <Field label="Guard profile" help="Empty keeps the installation's profile">
              {({ id }) => (
                <Input id={id} disabled={disabled} value={String(entry.guardProfileId ?? '')} onChange={(e) => onChange('guardProfileId', e.target.value || undefined)} />
              )}
            </Field>
          </div>
        </>
      ) : null}
    </form>
  );
}

import * as React from 'react';
import { Field } from '@/components/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  type FormField,
  fieldsOf,
  type JsonSchema,
  listToText,
  parseNumber,
  textToList,
} from '@/lib/json-schema-form';
import { jsonText, useFollowedText } from '@/lib/use-followed-text';

type Args = Record<string, unknown>;

/** A value that only JSON can express, edited as text; text that does not parse is flagged and not written. */
function JsonValueField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: unknown;
  disabled?: boolean | undefined;
  onChange: (v: unknown) => void;
}) {
  // The value changes from outside with the JSON view: the text follows it, never overwriting what is being typed.
  const { text, setText, markWritten } = useFollowedText(value, jsonText);
  const [error, setError] = React.useState<string | undefined>();
  return (
    <Field
      label={`${field.label}${field.required ? ' *' : ''}`}
      help={field.description ?? 'JSON'}
      error={error}
    >
      {({ id, describedBy, invalid }) => (
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          disabled={disabled}
          spellCheck={false}
          value={text}
          className="min-h-16 font-mono text-[12px]"
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            if (t.trim() === '') {
              setError(undefined);
              markWritten(undefined);
              onChange(undefined);
              return;
            }
            try {
              const v = JSON.parse(t);
              setError(undefined);
              markWritten(v);
              onChange(v);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Not valid JSON');
            }
          }}
        />
      )}
    </Field>
  );
}

/**
 * One item per line. The text is kept as typed (a new line must be typeable before anything follows it); the list is
 * derived from it, and the text follows the list only when the list changed from outside (the JSON view).
 */
function ListField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: unknown;
  disabled?: boolean | undefined;
  onChange: (v: unknown[] | undefined) => void;
}) {
  const { text, setText, markWritten } = useFollowedText(value, listToText);
  return (
    <Field
      label={`${field.label}${field.required ? ' *' : ''}`}
      help={field.description ?? 'One item per line'}
    >
      {({ id, describedBy }) => (
        <Textarea
          id={id}
          aria-describedby={describedBy}
          disabled={disabled}
          spellCheck={false}
          value={text}
          className="min-h-16 font-mono text-[12px]"
          onChange={(e) => {
            setText(e.target.value);
            const list = textToList(e.target.value, field.itemKind);
            markWritten(list);
            onChange(list);
          }}
        />
      )}
    </Field>
  );
}

/**
 * One input per parameter of an input schema (12.5): text, numbers, true or false, a choice from the schema's own
 * values, a list with one item per line, and JSON for what is nested. Required parameters are marked and come first.
 */
export function SchemaForm({
  schema,
  value,
  disabled,
  onChange,
}: {
  schema: JsonSchema | undefined;
  value: Args;
  disabled?: boolean | undefined;
  onChange: (next: Args) => void;
}) {
  const fields = React.useMemo(() => fieldsOf(schema), [schema]);
  const set = (name: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[name];
    else next[name] = v;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3.5">
      {fields.map((f) => {
        const label = `${f.label}${f.required ? ' *' : ''}`;
        const current = value[f.name];
        switch (f.kind) {
          case 'string':
            return (
              <Field key={f.name} label={label} help={f.description}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    disabled={disabled}
                    autoComplete="off"
                    value={typeof current === 'string' ? current : ''}
                    onChange={(e) =>
                      set(f.name, e.target.value === '' ? undefined : e.target.value)
                    }
                  />
                )}
              </Field>
            );
          case 'number':
          case 'integer':
            return (
              <Field key={f.name} label={label} help={f.description}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    disabled={disabled}
                    type="number"
                    step={f.kind === 'integer' ? 1 : 'any'}
                    value={typeof current === 'number' ? current : ''}
                    onChange={(e) => set(f.name, parseNumber(e.target.value, f.kind === 'integer'))}
                  />
                )}
              </Field>
            );
          case 'boolean':
            return (
              <Field key={f.name} label={label} help={f.description}>
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    disabled={disabled}
                    value={typeof current === 'boolean' ? String(current) : ''}
                    onChange={(e) =>
                      set(f.name, e.target.value === '' ? undefined : e.target.value === 'true')
                    }
                  >
                    <option value="">Not set</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </Select>
                )}
              </Field>
            );
          case 'enum':
            return (
              <Field key={f.name} label={label} help={f.description}>
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    disabled={disabled}
                    value={current === undefined ? '' : JSON.stringify(current)}
                    onChange={(e) =>
                      set(f.name, e.target.value === '' ? undefined : JSON.parse(e.target.value))
                    }
                  >
                    <option value="">Not set</option>
                    {f.enumValues.map((v) => (
                      <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            );
          case 'list':
            return (
              <ListField
                key={f.name}
                field={f}
                value={current}
                disabled={disabled}
                onChange={(v) => set(f.name, v)}
              />
            );
          default:
            return (
              <JsonValueField
                key={f.name}
                field={f}
                value={current}
                disabled={disabled}
                onChange={(v) => set(f.name, v)}
              />
            );
        }
      })}
    </div>
  );
}

import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import {
  type ArgDraft,
  type AuthMode,
  type BindingDraft,
  HEADER_NAME,
  type SpecDraft,
  secretNamesOf,
  setRowSecret,
  TEMPLATE_NAME,
  templateError,
  type VariableDraft,
} from '../draft';

// --- row layout ---------------------------------------------------------------------------------------------------------
//
// Every editable row is a grid of cells. A cell is a label line above a 44px control line, nothing else: hints and
// errors never go inside a cell (they would push that cell's control out of line with its siblings), they live in the
// card's description or in one line under the whole row. The row sits in a container so its columns follow the width of
// the card, not of the window.

/** A labelled control in a row: label above, a control line of the same height as an input below. */
export function RowCell({
  label,
  hideLabel,
  className,
  children,
}: {
  label: string;
  hideLabel?: boolean;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label
        htmlFor={id}
        className={cn('text-[13px] font-medium leading-5 text-ink', hideLabel && 'sr-only')}
      >
        {label}
      </Label>
      <div className="flex h-11 items-center">{children(id)}</div>
    </div>
  );
}

/** The checkbox cell ("Required", "Secret"): the box centred on the control line. */
export function CheckCell({
  label,
  checked,
  disabled,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (on: boolean) => void;
  title?: string;
}) {
  return (
    <RowCell label={label} className="items-center">
      {(id) => (
        <input
          id={id}
          type="checkbox"
          title={title}
          className="size-[18px] accent-[var(--tangerine-ink)]"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}
    </RowCell>
  );
}

export function RemoveCell({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean | undefined;
  onClick: () => void;
}) {
  return (
    <RowCell label="Remove" hideLabel className="items-center">
      {() => (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      )}
    </RowCell>
  );
}

export const ROW = 'grid items-end gap-x-3 gap-y-2';

/** A row card: the container the columns respond to, and one line for what is wrong with the row. */
export function RowCard({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="@container rounded-md border border-line p-3">
      <div className="flex flex-col gap-3">{children}</div>
      {error ? (
        <p role="alert" className="m-0 mt-2 text-caption font-medium text-coral-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const nameProblem = (name: string): string | undefined =>
  name && !TEMPLATE_NAME.test(name) ? 'Use letters, digits and underscore' : undefined;

/** What a row of a list gets: its place in the list, its value, and how to change or remove it. */
export type RowProps<T> = {
  /** Position in its list: the name of the group, stable while the row is being typed. */
  index: number;
  row: T;
  readOnly?: boolean | undefined;
  onChange: (next: T) => void;
  onRemove: () => void;
};

/** A row that may carry a credential: it needs the spec and the auth mode to name the secret. */
export type SecretRowProps<T> = RowProps<T> & {
  spec: SpecDraft;
  mode: AuthMode;
  /** The id of the `datalist` that suggests `{{var.NAME}}` and `{{secret.NAME}}`. */
  listId: string;
};

/** `{{var.NAME}}` and `{{secret.NAME}}` suggestions for the value inputs. */
const referencesOf = (s: SpecDraft): string[] => [
  ...s.variables.filter((v) => v.name).map((v) => `{{var.${v.name}}}`),
  ...secretNamesOf(s).map((n) => `{{secret.${n}}}`),
];

export function ReferenceList({ id, spec }: { id: string; spec: SpecDraft }) {
  return (
    <datalist id={id}>
      {referencesOf(spec).map((r) => (
        <option key={r} value={r} />
      ))}
    </datalist>
  );
}

export function VariableRow({
  row: v,
  index,
  readOnly,
  onChange,
  onRemove,
}: RowProps<VariableDraft>) {
  return (
    <RowCard label={`Variable ${index + 1}`} error={nameProblem(v.name) ?? undefined}>
      <div
        className={cn(
          ROW,
          'grid-cols-2',
          '@[30rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto_auto]',
        )}
      >
        <RowCell label="Name">
          {(id) => (
            <Input
              id={id}
              aria-invalid={Boolean(nameProblem(v.name))}
              disabled={readOnly}
              value={v.name}
              onChange={(e) => onChange({ ...v, name: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Label">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.label}
              onChange={(e) => onChange({ ...v, label: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Default">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.default}
              onChange={(e) => onChange({ ...v, default: e.target.value })}
            />
          )}
        </RowCell>
        <CheckCell
          label="Required"
          checked={v.required}
          disabled={readOnly}
          onChange={(required) => onChange({ ...v, required })}
        />
        <RemoveCell
          label={`Remove variable ${v.name || index + 1}`}
          disabled={readOnly}
          onClick={onRemove}
        />
      </div>
      <div className={cn(ROW, 'grid-cols-1', '@[30rem]:grid-cols-2')}>
        <RowCell label="Description">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.description}
              placeholder="Shown under the field when someone installs"
              onChange={(e) => onChange({ ...v, description: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Choices">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.choices}
              placeholder="eu, us (empty: any text)"
              onChange={(e) => onChange({ ...v, choices: e.target.value })}
            />
          )}
        </RowCell>
      </div>
    </RowCard>
  );
}

/** One header or environment variable: name, value template, Secret switch, remove. */
export function BindingRow({
  kind,
  index,
  row,
  spec,
  mode,
  readOnly,
  listId,
  onChange,
  onRemove,
}: SecretRowProps<BindingDraft> & { kind: 'header' | 'env' }) {
  const noun = kind === 'header' ? 'header' : 'environment variable';
  const nameBad =
    kind === 'header'
      ? row.name && !HEADER_NAME.test(row.name)
        ? 'Not a valid header name'
        : undefined
      : nameProblem(row.name);
  const valueBad = row.value ? templateError(row.value) : undefined;
  return (
    <RowCard
      label={`${noun[0]?.toUpperCase()}${noun.slice(1)} ${index + 1}`}
      error={nameBad ?? valueBad}
    >
      <div
        className={cn(
          ROW,
          'grid-cols-2',
          '@[30rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto_auto]',
        )}
      >
        <RowCell label={kind === 'header' ? 'Header name' : 'Name'}>
          {(id) => (
            <Input
              id={id}
              aria-invalid={Boolean(nameBad)}
              disabled={readOnly}
              value={row.name}
              placeholder={kind === 'header' ? 'Authorization' : 'DATABASE_URL'}
              onChange={(e) => onChange({ ...row, name: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Value">
          {(id) => (
            <Input
              id={id}
              list={listId}
              aria-invalid={Boolean(valueBad)}
              disabled={readOnly}
              className="font-mono text-[13px]"
              value={row.value}
              placeholder={
                kind === 'header' ? 'Bearer {{secret.TOKEN}}' : 'a value, or {{var.NAME}}'
              }
              onChange={(e) => onChange({ ...row, value: e.target.value })}
            />
          )}
        </RowCell>
        <CheckCell
          label="Secret"
          checked={row.secret}
          disabled={readOnly}
          title="A secret value is stored encrypted and injected by Bastion"
          onChange={(on) => {
            const next = setRowSecret(row, on, secretNamesOf(spec), mode);
            onChange(next);
          }}
        />
        <RemoveCell
          label={`Remove ${noun} ${row.name || ''}`.trim()}
          disabled={readOnly}
          onClick={onRemove}
        />
      </div>
    </RowCard>
  );
}

export function ArgRow({
  index,
  row,
  spec,
  mode,
  readOnly,
  listId,
  onChange,
  onRemove,
}: SecretRowProps<ArgDraft>) {
  const valueBad = row.value ? templateError(row.value) : undefined;
  return (
    <RowCard label={`Argument ${index + 1}`} error={valueBad}>
      <div
        className={cn(
          ROW,
          'grid-cols-2',
          '@[30rem]:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto]',
        )}
      >
        <RowCell label="Argument type">
          {(id) => (
            <Select
              id={id}
              disabled={readOnly}
              value={row.kind}
              onChange={(e) => onChange({ ...row, kind: e.target.value as ArgDraft['kind'] })}
            >
              <option value="positional">Positional</option>
              <option value="named">Named</option>
            </Select>
          )}
        </RowCell>
        <RowCell label="Flag">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly || row.kind === 'positional'}
              value={row.kind === 'positional' ? '' : row.name}
              placeholder={row.kind === 'positional' ? '(none)' : '--region'}
              onChange={(e) => onChange({ ...row, name: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Argument value">
          {(id) => (
            <Input
              id={id}
              list={listId}
              aria-invalid={Boolean(valueBad)}
              disabled={readOnly}
              className="font-mono text-[13px]"
              value={row.value}
              placeholder="a value, or {{var.NAME}}"
              onChange={(e) => onChange({ ...row, value: e.target.value })}
            />
          )}
        </RowCell>
        <CheckCell
          label="Secret"
          checked={row.secret}
          disabled={readOnly}
          onChange={(on) => onChange(setRowSecret(row, on, secretNamesOf(spec), mode))}
        />
        <RemoveCell
          label={`Remove argument ${row.name || row.value}`.trim()}
          disabled={readOnly}
          onClick={onRemove}
        />
      </div>
    </RowCard>
  );
}

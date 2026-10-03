import { KeyRound, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useOrgSecretNames } from '@/api/hooks';
import type { DriftPolicy, RiskLevel } from '@/api/schema';
import { useAuth } from '@/auth/auth';
import { CodeEditor } from '@/components/code-editor';
import { Field } from '@/components/form';
import { Card, CardHeader, Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import { overrideJsonSchema, validateOverrideText } from '@/lib/override-schema';
import {
  type ArgDraft,
  type AuthMode,
  type BindingDraft,
  type Draft,
  emptyVariable,
  HEADER_NAME,
  type HeaderPreset,
  headerPreset,
  isEgressRule,
  LIMITS,
  needsClientSecret,
  type OAuthClientDraft,
  oauthClientSecretName,
  type SpecDraft,
  secretNamesOf,
  setRowSecret,
  slugify,
  TEMPLATE_NAME,
  templateError,
  type UserOverrides,
  type VariableDraft,
} from './draft';
import { importSnippet } from './import-snippet';
import { NEW_TEAM_LABEL, NEW_TEAM_VALUE, useEditorTeams, useNewTeamDialog } from './team-picker';

export type { Draft };

type Props = {
  draft: Draft;
  onChange: (d: Draft) => void;
  readOnly?: boolean;
  /** Server-side field errors of the last save, keyed by field (`slug`, `label`...). */
  errors?: Record<string, string>;
  /** Whether the entry already exists: its URL name, owner and kind cannot change then. */
  existing?: boolean;
};

const setSpec = (d: Draft, patch: Partial<SpecDraft>): Draft => ({
  ...d,
  spec: { ...d.spec, ...patch },
});

type SourceKind = 'npm' | 'pypi' | 'remote';
const sourceKind = (s: SpecDraft): SourceKind => (s.type === 'remote' ? 'remote' : s.runtime);

// --- row layout ---------------------------------------------------------------------------------------------------------
//
// Every editable row is a grid of cells. A cell is a label line above a 44px control line, nothing else: hints and
// errors never go inside a cell (they would push that cell's control out of line with its siblings), they live in the
// card's description or in one line under the whole row. The row sits in a container so its columns follow the width of
// the card, not of the window.

/** A labelled control in a row: label above, a control line of the same height as an input below. */
function RowCell({
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
function CheckCell({
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

function RemoveCell({
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

const ROW = 'grid items-end gap-x-3 gap-y-2';

/** A row card: the container the columns respond to, and one line for what is wrong with the row. */
function RowCard({
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

const nameProblem = (name: string): string | undefined =>
  name && !TEMPLATE_NAME.test(name) ? 'Use letters, digits and underscore' : undefined;

// --- Source -------------------------------------------------------------------------------------------------------------

export function SourceStep({ draft, onChange, readOnly, errors, existing }: Props) {
  const [paste, setPaste] = React.useState('');
  const [importError, setImportError] = React.useState<string | undefined>();
  const [slugEdited, setSlugEdited] = React.useState(Boolean(existing));
  const { role } = useAuth();
  const owners = useEditorTeams();
  const newTeam = useNewTeamDialog((team) => onChange({ ...draft, ownerTeamId: team.id }));
  const s = draft.spec;
  const ownerName = owners.teams.find((t) => t.id === draft.ownerTeamId)?.name;
  return (
    <Card aria-label="Source" className="gap-4">
      <CardHeader title="Source" subtitle="Where the server comes from" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" required error={errors?.displayName}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={readOnly}
              maxLength={LIMITS.displayName}
              value={draft.displayName}
              onChange={(e) =>
                onChange({
                  ...draft,
                  displayName: e.target.value,
                  slug: slugEdited ? draft.slug : slugify(e.target.value, LIMITS.slug),
                })
              }
            />
          )}
        </Field>
        <Field
          label="URL name"
          help={existing ? 'Fixed once the entry exists' : 'Unique in your org; follows the name'}
          error={errors?.slug}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={readOnly || existing}
              maxLength={LIMITS.slug}
              value={draft.slug}
              onChange={(e) => {
                setSlugEdited(true);
                onChange({ ...draft, slug: slugify(e.target.value, LIMITS.slug) });
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Description">
        {({ id }) => (
          <Textarea
            id={id}
            disabled={readOnly}
            className="min-h-16"
            maxLength={LIMITS.description}
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Owner"
          className="min-w-56 flex-1"
          help={
            existing
              ? 'Fixed once the entry exists'
              : role === 'admin'
                ? 'The team that maintains this entry, or the whole organization'
                : 'The team you manage that maintains this entry'
          }
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              disabled={readOnly || existing}
              value={draft.ownerTeamId ?? ''}
              onChange={(e) =>
                e.target.value === NEW_TEAM_VALUE
                  ? newTeam.open()
                  : onChange({ ...draft, ownerTeamId: e.target.value || null })
              }
            >
              {role === 'admin' || !draft.ownerTeamId ? (
                <option value="" disabled={role !== 'admin'}>
                  {role === 'admin' ? 'Organization' : 'Pick a team'}
                </option>
              ) : null}
              {owners.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  Team · {t.name}
                </option>
              ))}
              {draft.ownerTeamId && !ownerName ? (
                <option value={draft.ownerTeamId}>{draft.ownerTeamId}</option>
              ) : null}
              {owners.canCreate && !existing && !readOnly ? (
                <option value={NEW_TEAM_VALUE}>{NEW_TEAM_LABEL}</option>
              ) : null}
            </Select>
          )}
        </Field>
        {newTeam.dialog}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Runtime">
          {({ id }) => (
            <Select
              id={id}
              disabled={readOnly}
              value={sourceKind(s)}
              onChange={(e) => {
                const kind = e.target.value as SourceKind;
                onChange(
                  setSpec(draft, {
                    type: kind === 'remote' ? 'remote' : 'package',
                    ...(kind === 'remote' ? {} : { runtime: kind }),
                  }),
                );
              }}
            >
              <option value="remote">Remote (URL)</option>
              <option value="npm">npm package</option>
              <option value="pypi">Python (PyPI)</option>
            </Select>
          )}
        </Field>
        {s.type === 'remote' ? (
          <>
            <Field label="Server URL" className="sm:col-span-2">
              {({ id }) => (
                <Input
                  id={id}
                  disabled={readOnly}
                  value={s.url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(e) => onChange(setSpec(draft, { url: e.target.value }))}
                />
              )}
            </Field>
            <Field label="Transport">
              {({ id }) => (
                <Select
                  id={id}
                  disabled={readOnly}
                  value={s.transport}
                  onChange={(e) =>
                    onChange(
                      setSpec(draft, { transport: e.target.value as SpecDraft['transport'] }),
                    )
                  }
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE (legacy)</option>
                </Select>
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="Package">
              {({ id }) => (
                <Input
                  id={id}
                  disabled={readOnly}
                  value={s.identifier}
                  placeholder="@acme/pg-mcp"
                  onChange={(e) => onChange(setSpec(draft, { identifier: e.target.value }))}
                />
              )}
            </Field>
            <Field label="Version" help="Pinned to the exact version">
              {({ id }) => (
                <Input
                  id={id}
                  disabled={readOnly}
                  value={s.version}
                  placeholder="3.2.0"
                  onChange={(e) => {
                    const version = e.target.value;
                    const follows = draft.label === s.version;
                    onChange({
                      ...setSpec(draft, { version }),
                      label: follows ? version : draft.label,
                    });
                  }}
                />
              )}
            </Field>
          </>
        )}
        <Field label="Version label" help="Names this version in the catalog" error={errors?.label}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={readOnly}
              maxLength={LIMITS.label}
              value={draft.label}
              onChange={(e) => onChange({ ...draft, label: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-2 rounded-md bg-sunken p-3.5">
        <Field label="Import from a client config or server.json" error={importError}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className="min-h-20 font-mono text-[12px]"
              value={paste}
              placeholder={'{ "command": "npx", "args": ["-y", "@acme/pg-mcp@3.2.0"] }'}
              onChange={(e) => setPaste(e.target.value)}
            />
          )}
        </Field>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={readOnly || !paste.trim()}
          onClick={() => {
            const r = importSnippet(paste);
            if ('error' in r) return setImportError(r.error);
            setImportError(undefined);
            onChange(
              r.runtime === 'remote'
                ? setSpec(draft, { type: 'remote', url: r.url })
                : {
                    ...setSpec(draft, {
                      type: 'package',
                      runtime: r.runtime === 'python' ? 'pypi' : 'npm',
                      identifier: r.package,
                      version: r.version,
                    }),
                    label: r.version || draft.label,
                  },
            );
          }}
        >
          Import
        </Button>
      </div>
    </Card>
  );
}

// --- Configuration -------------------------------------------------------------------------------------------------------

/** `{{var.NAME}}` and `{{secret.NAME}}` suggestions for the value inputs. */
const referencesOf = (s: SpecDraft): string[] => [
  ...s.variables.filter((v) => v.name).map((v) => `{{var.${v.name}}}`),
  ...secretNamesOf(s).map((n) => `{{secret.${n}}}`),
];

function ReferenceList({ id, spec }: { id: string; spec: SpecDraft }) {
  return (
    <datalist id={id}>
      {referencesOf(spec).map((r) => (
        <option key={r} value={r} />
      ))}
    </datalist>
  );
}

function VariableRow({
  v,
  index,
  readOnly,
  onChange,
  onRemove,
}: {
  v: VariableDraft;
  index: number;
  readOnly?: boolean | undefined;
  onChange: (patch: Partial<VariableDraft>) => void;
  onRemove: () => void;
}) {
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
              onChange={(e) => onChange({ name: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Label">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          )}
        </RowCell>
        <RowCell label="Default">
          {(id) => (
            <Input
              id={id}
              disabled={readOnly}
              value={v.default}
              onChange={(e) => onChange({ default: e.target.value })}
            />
          )}
        </RowCell>
        <CheckCell
          label="Required"
          checked={v.required}
          disabled={readOnly}
          onChange={(required) => onChange({ required })}
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
              onChange={(e) => onChange({ description: e.target.value })}
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
              onChange={(e) => onChange({ choices: e.target.value })}
            />
          )}
        </RowCell>
      </div>
    </RowCard>
  );
}

/** One header or environment variable: name, value template, Secret switch, remove. */
function BindingRow({
  kind,
  index,
  row,
  spec,
  mode,
  readOnly,
  listId,
  onChange,
  onRemove,
}: {
  kind: 'header' | 'env';
  /** Position in its list: the name of the group, stable while the row is being typed. */
  index: number;
  row: BindingDraft;
  spec: SpecDraft;
  mode: AuthMode;
  readOnly?: boolean | undefined;
  listId: string;
  onChange: (next: BindingDraft) => void;
  onRemove: () => void;
}) {
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

function ArgRow({
  index,
  row,
  spec,
  mode,
  readOnly,
  listId,
  onChange,
  onRemove,
}: {
  index: number;
  row: ArgDraft;
  spec: SpecDraft;
  mode: AuthMode;
  readOnly?: boolean | undefined;
  listId: string;
  onChange: (next: ArgDraft) => void;
  onRemove: () => void;
}) {
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

const newEnv = (): BindingDraft => ({ name: '', value: '', secret: false });
const newArg = (): ArgDraft => ({ kind: 'positional', name: '', value: '', secret: false });

export function ConfigurationStep({ draft, onChange, readOnly }: Props) {
  const spec = draft.spec;
  const vars = spec.variables;
  const listId = React.useId();
  const updateVar = (i: number, patch: Partial<VariableDraft>) =>
    onChange(setSpec(draft, { variables: vars.map((v, k) => (k === i ? { ...v, ...patch } : v)) }));
  const isPackage = spec.type === 'package';
  return (
    <>
      <Card aria-label="Configuration" className="gap-4">
        <CardHeader
          title="Configuration"
          subtitle="Variables people fill in when they install"
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              onClick={() => onChange(setSpec(draft, { variables: [...vars, emptyVariable()] }))}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add variable
            </Button>
          }
        />
        <p className="m-0 text-caption text-muted">
          Names use letters, digits and underscore. Refer to a variable as {'{{var.NAME}}'}
          {isPackage ? ' in an environment variable or argument below' : ' in the URL or a header'}.
        </p>
        {vars.length === 0 ? (
          <p className="m-0 text-muted">
            No variables: people can install without filling anything in.
          </p>
        ) : null}
        {vars.map((v, i) => (
          <VariableRow
            key={i}
            v={v}
            index={i}
            readOnly={readOnly}
            onChange={(patch) => updateVar(i, patch)}
            onRemove={() => onChange(setSpec(draft, { variables: vars.filter((_, k) => k !== i) }))}
          />
        ))}
      </Card>
      {isPackage ? (
        <>
          <Card aria-label="Environment variables" className="gap-4">
            <CardHeader
              title="Environment variables"
              subtitle="Set for the server process"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => onChange(setSpec(draft, { envVars: [...spec.envVars, newEnv()] }))}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add environment variable
                </Button>
              }
            />
            <p className="m-0 text-caption text-muted">
              A fixed value, a variable ({'{{var.NAME}}'}) or a secret. Tick Secret for a token or
              key: Authentication says who provides it.
            </p>
            <ReferenceList id={listId} spec={spec} />
            {spec.envVars.length === 0 ? (
              <p className="m-0 text-muted">No environment variables.</p>
            ) : null}
            {spec.envVars.map((row, i) => (
              <BindingRow
                key={i}
                kind="env"
                index={i}
                row={row}
                spec={spec}
                mode={spec.authMode}
                readOnly={readOnly}
                listId={listId}
                onChange={(next) =>
                  onChange(
                    setSpec(draft, { envVars: spec.envVars.map((r, k) => (k === i ? next : r)) }),
                  )
                }
                onRemove={() =>
                  onChange(setSpec(draft, { envVars: spec.envVars.filter((_, k) => k !== i) }))
                }
              />
            ))}
          </Card>
          <Card aria-label="Arguments" className="gap-4">
            <CardHeader
              title="Arguments"
              subtitle="Passed to the server on the command line"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => onChange(setSpec(draft, { args: [...spec.args, newArg()] }))}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add argument
                </Button>
              }
            />
            {spec.args.length === 0 ? <p className="m-0 text-muted">No arguments.</p> : null}
            {spec.args.map((row, i) => (
              <ArgRow
                key={i}
                index={i}
                row={row}
                spec={spec}
                mode={spec.authMode}
                readOnly={readOnly}
                listId={listId}
                onChange={(next) =>
                  onChange(setSpec(draft, { args: spec.args.map((r, k) => (k === i ? next : r)) }))
                }
                onRemove={() =>
                  onChange(setSpec(draft, { args: spec.args.filter((_, k) => k !== i) }))
                }
              />
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

// --- Authentication ---------------------------------------------------------------------------------------------------------

const AUTH_OPTIONS: { value: AuthMode; label: string; help: string }[] = [
  { value: 'none', label: 'None', help: 'The server needs no credentials' },
  {
    value: 'orgSecret',
    label: 'Shared secret',
    help: 'You enter the token once; everyone uses it',
  },
  {
    value: 'userSecret',
    label: 'Personal secret',
    help: 'Each person enters their own token when they install',
  },
  { value: 'oauth', label: 'OAuth', help: 'Each person signs in to the upstream' },
];

/**
 * Shared secrets: the author types each value once (written through the secrets API, encrypted, never shown again;
 * the editor only knows "set"). Personal secrets: the author names the field each installer fills in.
 */
function SecretsSection({
  draft,
  onChange,
  readOnly,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  readOnly?: boolean | undefined;
}) {
  const spec = draft.spec;
  const { role } = useAuth();
  const names = secretNamesOf(spec);
  const shared = spec.authMode === 'orgSecret';
  const existing = useOrgSecretNames(shared);
  if (names.length === 0) return null;
  return (
    <section aria-label="Secrets" className="flex flex-col gap-3 rounded-md bg-sunken p-3.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden="true" />
        <h3 className="m-0 text-label">{shared ? 'Shared secrets' : 'Personal secrets'}</h3>
      </div>
      <p className="m-0 text-caption text-muted">
        {shared
          ? 'Stored encrypted when you save the draft. The value is never shown again; type a new one to replace it.'
          : 'Each person enters their own value when they install. The label tells them what to enter.'}
      </p>
      {shared && role !== 'admin' ? (
        <p role="note" className="m-0 text-caption font-medium text-coral-ink">
          Only an Admin can set shared secrets. Ask an Admin to enter the value, or use a personal
          secret.
        </p>
      ) : null}
      {names.map((name) => {
        const isSet = existing.data?.has(name) ?? false;
        const typed = Boolean(spec.secretValues[name]);
        return (
          <div
            key={name}
            className="grid items-end gap-x-3 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] font-medium leading-5">Secret</span>
              <code className="flex h-11 items-center truncate font-mono text-[13px]">{name}</code>
            </div>
            {shared ? (
              <RowCell label={`Value of ${name}`}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    disabled={readOnly}
                    placeholder={isSet ? 'Set. Type to replace' : 'Paste the token'}
                    value={spec.secretValues[name] ?? ''}
                    onChange={(e) =>
                      onChange(
                        setSpec(draft, {
                          secretValues: { ...spec.secretValues, [name]: e.target.value },
                        }),
                      )
                    }
                  />
                )}
              </RowCell>
            ) : (
              <RowCell label={`Label for ${name}`}>
                {(id) => (
                  <Input
                    id={id}
                    disabled={readOnly}
                    placeholder={name}
                    value={spec.secretLabels[name] ?? ''}
                    onChange={(e) =>
                      onChange(
                        setSpec(draft, {
                          secretLabels: { ...spec.secretLabels, [name]: e.target.value },
                        }),
                      )
                    }
                  />
                )}
              </RowCell>
            )}
            {shared ? (
              <div className="flex h-11 items-center">
                <Chip tone={isSet || typed ? 'ok' : 'warn'}>
                  {typed ? 'Will be saved' : isSet ? 'Set' : 'Not set'}
                </Chip>
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

const PRESETS: { id: HeaderPreset; label: string; help: string }[] = [
  { id: 'bearer', label: 'Bearer token', help: 'Authorization: Bearer <token>' },
  { id: 'apiKey', label: 'API key header', help: 'X-API-Key: <key>' },
  { id: 'custom', label: 'Custom header', help: 'Any name and value' },
];

/** Headers of a remote server, with presets for the common credentials (9.5). */
function HeadersEditor({ draft, onChange, readOnly }: Omit<Props, 'errors' | 'existing'>) {
  const spec = draft.spec;
  const listId = React.useId();
  const add = (kind: HeaderPreset) => {
    const row = headerPreset(kind, spec);
    // A credential header needs a place the secret comes from: default to a shared secret.
    const mode =
      row.secret && spec.authMode !== 'orgSecret' && spec.authMode !== 'userSecret'
        ? 'orgSecret'
        : spec.authMode;
    onChange(setSpec(draft, { headers: [...spec.headers, row], authMode: mode }));
  };
  return (
    <section aria-label="Headers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="m-0 min-w-0 flex-1 text-label">Headers</h3>
        <div role="group" aria-label="Add header" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="outline"
              size="sm"
              title={p.help}
              disabled={readOnly}
              onClick={() => add(p.id)}
            >
              <Plus className="size-4" aria-hidden="true" />
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="m-0 text-caption text-muted">
        Sent with every request to the server. A secret header value comes from the secret mode
        above: write it as {'{{secret.NAME}}'}, for example Bearer {'{{secret.TOKEN}}'}.
      </p>
      <ReferenceList id={listId} spec={spec} />
      {spec.headers.length === 0 ? <p className="m-0 text-muted">No extra headers.</p> : null}
      {spec.headers.map((row, i) => (
        <BindingRow
          key={i}
          kind="header"
          index={i}
          row={row}
          spec={spec}
          mode={spec.authMode}
          readOnly={readOnly}
          listId={listId}
          onChange={(next) =>
            onChange(setSpec(draft, { headers: spec.headers.map((r, k) => (k === i ? next : r)) }))
          }
          onRemove={() =>
            onChange(setSpec(draft, { headers: spec.headers.filter((_, k) => k !== i) }))
          }
        />
      ))}
    </section>
  );
}

/** Packages: the secret environment variables and arguments, where Configuration also lists them. */
function PackageSecrets({ draft, onChange, readOnly }: Omit<Props, 'errors' | 'existing'>) {
  const spec = draft.spec;
  const listId = React.useId();
  const mode = spec.authMode;
  const addEnv = () => {
    const taken = secretNamesOf(spec);
    const name = `SECRET_${taken.length + 1}`;
    onChange(
      setSpec(draft, {
        envVars: [
          ...spec.envVars,
          {
            name: '',
            secret: true,
            value: mode === 'oauth' ? '{{oauth.accessToken}}' : `{{secret.${name}}}`,
          },
        ],
      }),
    );
  };
  const addArg = () =>
    onChange(
      setSpec(draft, {
        args: [
          ...spec.args,
          {
            kind: 'named',
            name: '--token',
            secret: true,
            value: mode === 'oauth' ? '{{oauth.accessToken}}' : '{{secret.TOKEN}}',
          },
        ],
      }),
    );
  return (
    <section aria-label="Secret bindings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="m-0 min-w-0 flex-1 text-label">
          {mode === 'oauth' ? 'Where the access token goes' : 'Where the secret goes'}
        </h3>
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={addEnv}>
          <Plus className="size-4" aria-hidden="true" />
          Add secret environment variable
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={addArg}>
          <Plus className="size-4" aria-hidden="true" />
          Add secret argument
        </Button>
      </div>
      <p className="m-0 text-caption text-muted">
        The secret reaches the server as an environment variable or an argument. Plain ones are in
        Configuration.
      </p>
      <ReferenceList id={listId} spec={spec} />
      {spec.envVars.map((row, i) =>
        row.secret ? (
          <BindingRow
            key={`e${i}`}
            kind="env"
            index={i}
            row={row}
            spec={spec}
            mode={mode}
            readOnly={readOnly}
            listId={listId}
            onChange={(next) =>
              onChange(
                setSpec(draft, { envVars: spec.envVars.map((r, k) => (k === i ? next : r)) }),
              )
            }
            onRemove={() =>
              onChange(setSpec(draft, { envVars: spec.envVars.filter((_, k) => k !== i) }))
            }
          />
        ) : null,
      )}
      {spec.args.map((row, i) =>
        row.secret ? (
          <ArgRow
            key={`a${i}`}
            index={i}
            row={row}
            spec={spec}
            mode={mode}
            readOnly={readOnly}
            listId={listId}
            onChange={(next) =>
              onChange(setSpec(draft, { args: spec.args.map((r, k) => (k === i ? next : r)) }))
            }
            onRemove={() => onChange(setSpec(draft, { args: spec.args.filter((_, k) => k !== i) }))}
          />
        ) : null,
      )}
    </section>
  );
}

/**
 * How Bastion identifies itself to the service behind an OAuth server (9.6). Most services let Bastion register itself;
 * some (GitHub) only accept an app registered by hand, whose client id and secret are entered here. The secret is
 * stored encrypted as a shared secret and never shown again.
 */
function OAuthClientSection({
  draft,
  onChange,
  readOnly,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  readOnly?: boolean | undefined;
}) {
  const spec = draft.spec;
  const client = spec.oauthClient;
  const { me, role } = useAuth();
  const manual = client.registration === 'preRegistered';
  const withSecret = needsClientSecret(spec);
  const secretName = oauthClientSecretName(client);
  const existing = useOrgSecretNames(withSecret);
  const isSet = existing.data?.has(secretName) ?? false;
  const set = (patch: Partial<OAuthClientDraft>) =>
    onChange(setSpec(draft, { oauthClient: { ...client, ...patch } }));
  const callback = `${me.org.baseUrl.replace(/\/$/, '')}/oauth/upstream/callback`;
  return (
    <section aria-label="OAuth app" className="flex flex-col gap-3 rounded-md bg-sunken p-3.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden="true" />
        <h3 className="m-0 text-label">OAuth app</h3>
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">How Bastion identifies itself</legend>
        {(
          [
            ['auto', 'Automatic', 'Bastion registers itself with the service'],
            ['preRegistered', 'An app I registered', 'The service needs a client ID and secret'],
          ] as const
        ).map(([value, label, help]) => (
          <label
            key={value}
            className={`flex min-h-11 items-center gap-3 rounded-md border bg-surface px-3 py-2 ${client.registration === value ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}
          >
            <input
              type="radio"
              name="oauth-registration"
              disabled={readOnly}
              checked={client.registration === value}
              onChange={() => set({ registration: value })}
              className="size-[18px] accent-[var(--tangerine-ink)]"
            />
            <span className="flex-1 text-label">{label}</span>
            <span className="text-caption text-muted">{help}</span>
          </label>
        ))}
      </fieldset>
      {manual ? (
        <>
          <p className="m-0 text-caption text-muted">
            Register an OAuth app with the service and give it this callback URL:{' '}
            <code className="break-all">{callback}</code>
          </p>
          <Field label="Client ID">
            {({ id }) => (
              <Input
                id={id}
                autoComplete="off"
                disabled={readOnly}
                value={client.clientId}
                onChange={(e) => set({ clientId: e.target.value })}
              />
            )}
          </Field>
          <Field label="How the secret is sent">
            {({ id }) => (
              <Select
                id={id}
                disabled={readOnly}
                value={client.authMethod}
                onChange={(e) =>
                  set({ authMethod: e.target.value as OAuthClientDraft['authMethod'] })
                }
              >
                <option value="client_secret_basic">Client secret, HTTP Basic (default)</option>
                <option value="client_secret_post">Client secret, in the request body</option>
                <option value="none">No secret (public client)</option>
              </Select>
            )}
          </Field>
          {withSecret ? (
            <Field
              label="Client secret"
              help={
                role !== 'admin'
                  ? 'Only an Admin can set shared secrets. Ask an Admin to enter it.'
                  : isSet
                    ? 'Set. Type to replace. Stored encrypted when you save the draft.'
                    : 'Stored encrypted when you save the draft. Never shown again.'
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  aria-describedby={describedBy}
                  disabled={readOnly || role !== 'admin'}
                  value={spec.secretValues[secretName] ?? ''}
                  onChange={(e) =>
                    onChange(
                      setSpec(draft, {
                        secretValues: { ...spec.secretValues, [secretName]: e.target.value },
                      }),
                    )
                  }
                />
              )}
            </Field>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function AuthenticationStep({ draft, onChange, readOnly }: Props) {
  const mode = draft.spec.authMode;
  const remote = draft.spec.type === 'remote';
  // The scopes are typed as one line; keep what was typed (a trailing space is not a scope).
  const [scopes, setScopes] = React.useState(() => draft.spec.oauthScopes.join(' '));
  const options =
    mode === 'other'
      ? [
          ...AUTH_OPTIONS,
          {
            value: 'other' as AuthMode,
            label: 'Identity provider',
            help: 'Managed by the identity provider: kept as imported',
          },
        ]
      : AUTH_OPTIONS;
  return (
    <Card aria-label="Authentication" className="gap-4">
      <CardHeader title="Authentication" subtitle="How Bastion signs in to the server" />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Authentication mode</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 ${mode === o.value ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}
          >
            <input
              type="radio"
              name="auth"
              disabled={readOnly || o.value === 'other'}
              checked={mode === o.value}
              onChange={() => onChange(setSpec(draft, { authMode: o.value }))}
              className="size-[18px] accent-[var(--tangerine-ink)]"
            />
            <span className="flex-1 text-label">{o.label}</span>
            <span className="text-caption text-muted">{o.help}</span>
          </label>
        ))}
      </fieldset>
      {mode === 'oauth' ? (
        <Field label="OAuth scopes" help="Space separated">
          {({ id }) => (
            <Input
              id={id}
              disabled={readOnly}
              value={scopes}
              onChange={(e) => {
                setScopes(e.target.value);
                onChange(
                  setSpec(draft, { oauthScopes: e.target.value.split(/\s+/).filter(Boolean) }),
                );
              }}
            />
          )}
        </Field>
      ) : null}
      {mode === 'oauth' ? (
        <OAuthClientSection draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {remote && mode !== 'other' ? (
        <HeadersEditor draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {!remote && (mode === 'orgSecret' || mode === 'userSecret' || mode === 'oauth') ? (
        <PackageSecrets draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {mode === 'orgSecret' || mode === 'userSecret' ? (
        <SecretsSection draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
    </Card>
  );
}

// --- Network ---------------------------------------------------------------------------------------------------------------

export function NetworkStep({ draft, onChange, readOnly }: Props) {
  const [host, setHost] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const hosts = draft.spec.egress;
  const remote = draft.spec.type === 'remote';
  const add = () => {
    const h = host.trim().toLowerCase();
    if (!h) return;
    if (!isEgressRule(h)) return setError('Use host[:port], *.suffix[:port] or a CIDR');
    setError(undefined);
    if (!hosts.includes(h)) onChange(setSpec(draft, { egress: [...hosts, h] }));
    setHost('');
  };
  return (
    <Card aria-label="Network" className="gap-4">
      <CardHeader
        title="Network"
        subtitle="The only places this server may connect (egress allowlist)"
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allowed hosts">
        {hosts.length === 0 ? (
          <span className="text-caption text-muted">No outbound access.</span>
        ) : null}
        {hosts.map((h) => (
          <Chip
            key={h}
            onRemove={
              readOnly
                ? undefined
                : () => onChange(setSpec(draft, { egress: hosts.filter((x) => x !== h) }))
            }
            removeLabel={`Remove ${h}`}
          >
            {h}
          </Chip>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <Field label="Add a host" className="flex-1" error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={readOnly || remote}
              value={host}
              placeholder="api.example.com"
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          )}
        </Field>
        <Button variant="outline" disabled={readOnly || !host.trim() || remote} onClick={add}>
          Add
        </Button>
      </div>
      {remote ? (
        <p className="m-0 text-caption text-muted">
          A remote server is reached by its URL; the allowlist applies to packages that Bastion
          runs.
        </p>
      ) : (
        <p className="m-0 text-caption text-muted">
          A host that resolves to an address on your own network (for example 192.168.1.2) is
          refused unless that address is listed here as well, such as <code>192.168.1.2/32</code>.
        </p>
      )}
      {remote ? null : (
        <Field label="Sandbox size">
          {({ id }) => (
            <Select
              id={id}
              disabled={readOnly}
              value={draft.spec.size}
              onChange={(e) =>
                onChange(setSpec(draft, { size: e.target.value as SpecDraft['size'] }))
              }
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </Select>
          )}
        </Field>
      )}
    </Card>
  );
}

// --- Overrides -------------------------------------------------------------------------------------------------------------

export function OverridesStep({ draft, onChange, readOnly }: Props) {
  const [text, setText] = React.useState(() => JSON.stringify(draft.overrides, null, 2));
  const v = validateOverrideText(text);
  const schema = React.useMemo(() => overrideJsonSchema(), []);
  const empty = v.ok && Object.keys(v.document).every((k) => k === 'version');
  return (
    <Card aria-label="Overrides" className="gap-4">
      <CardHeader
        title="Overrides"
        subtitle="The default overrides every installation starts from"
      />
      <CodeEditor
        language="json"
        ariaLabel="Default override document"
        height={280}
        value={text}
        readOnly={readOnly ?? false}
        jsonSchema={schema}
        onChange={(t) => {
          setText(t);
          const r = validateOverrideText(t);
          // The draft keeps the last valid document; the error blocks Save (not Back and Next), so a typo
          // is never saved silently and never traps the author on this step.
          onChange(
            r.ok
              ? { ...draft, overrides: r.document, overridesError: undefined }
              : {
                  ...draft,
                  overridesError: r.issues
                    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
                    .join('; '),
                },
          );
        }}
      />
      {v.ok ? (
        <p className="m-0 text-caption font-medium text-mint-ink">
          {empty
            ? 'Valid. Empty: installations start with no overrides. {} and {"version": 1} are the same.'
            : 'Valid override document.'}
        </p>
      ) : (
        <ul
          role="alert"
          className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink"
        >
          {v.issues.map((i) => (
            <li key={`${i.path}${i.message}`}>
              {i.path ? `${i.path}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <Field label="What may people override on their installs?">
        {({ id }) => (
          <Select
            id={id}
            disabled={readOnly}
            value={draft.userOverrides}
            onChange={(e) => onChange({ ...draft, userOverrides: e.target.value as UserOverrides })}
          >
            <option value="none">Nothing</option>
            <option value="cosmetic">Cosmetic: hide, rename, title, description</option>
            <option value="full">Full: also arguments and schema</option>
          </Select>
        )}
      </Field>
    </Card>
  );
}

// --- Security ----------------------------------------------------------------------------------------------------------------

export function SecurityStep({ draft, onChange, readOnly }: Props) {
  const { role } = useAuth();
  return (
    <Card aria-label="Security and limits" className="gap-4">
      <CardHeader
        title="Security and limits"
        subtitle="Guard profiles and limits are set org-wide in Settings"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="When a tool definition changes" help="Rug-pull protection (13.6)">
          {({ id }) => (
            <Select
              id={id}
              disabled={readOnly}
              value={draft.onDrift}
              onChange={(e) => onChange({ ...draft, onDrift: e.target.value as DriftPolicy })}
            >
              <option value="hideChanged">Hide changed tools until approved</option>
              <option value="block">Block the whole installation</option>
              <option value="warn">Warn only</option>
            </Select>
          )}
        </Field>
        {role === 'admin' ? (
          <Field label="Risk" help="Available to Cedar rules">
            {({ id }) => (
              <Select
                id={id}
                disabled={readOnly}
                value={draft.risk}
                onChange={(e) => onChange({ ...draft, risk: e.target.value as RiskLevel })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </Card>
  );
}

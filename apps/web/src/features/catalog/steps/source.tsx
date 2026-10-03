import * as React from 'react';
import { useAuth } from '@/auth/auth';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { LIMITS, type SpecDraft, slugify } from '../draft';
import { importSnippet } from '../import-snippet';
import { NEW_TEAM_LABEL, NEW_TEAM_VALUE, useEditorTeams, useNewTeamDialog } from '../team-picker';
import { type StepProps, setSpec } from './props';

type SourceKind = 'npm' | 'pypi' | 'remote';
const sourceKind = (s: SpecDraft): SourceKind => (s.type === 'remote' ? 'remote' : s.runtime);

export function SourceStep({ draft, onChange, readOnly, errors, existing }: StepProps) {
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

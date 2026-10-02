import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import type { AuthMode, CatalogDraftInput, SourceSpec } from '@/api/types';
import { useAuth } from '@/auth/auth';
import { CodeEditor } from '@/components/code-editor';
import { Field } from '@/components/form';
import { Card, CardHeader, Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { overrideJsonSchema, validateOverrideText } from '@/lib/override-schema';
import { importSnippet } from './import-snippet';

export type Draft = CatalogDraftInput;
type Props = { draft: Draft; onChange: (d: Draft) => void; readOnly?: boolean };

const setSpec = (d: Draft, patch: Partial<SourceSpec>): Draft => ({ ...d, spec: { ...d.spec, ...patch } });

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function SourceStep({ draft, onChange, readOnly }: Props) {
  const [paste, setPaste] = React.useState('');
  const [importError, setImportError] = React.useState<string | undefined>();
  const s = draft.spec;
  return (
    <Card aria-label="Source" className="gap-4">
      <CardHeader title="Source" subtitle="Where the server comes from" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" required>
          {({ id }) => (
            <Input id={id} disabled={readOnly} value={draft.displayName} onChange={(e) => onChange({ ...draft, displayName: e.target.value, slug: draft.slug && draft.slug !== slugify(draft.displayName) ? draft.slug : slugify(e.target.value) })} />
          )}
        </Field>
        <Field label="Slug" help="Unique in your org">
          {({ id }) => <Input id={id} disabled={readOnly} value={draft.slug} onChange={(e) => onChange({ ...draft, slug: slugify(e.target.value) })} />}
        </Field>
      </div>
      <Field label="Description">
        {({ id }) => <Textarea id={id} disabled={readOnly} className="min-h-16" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Runtime">
          {({ id }) => (
            <Select id={id} disabled={readOnly} value={s.runtime} onChange={(e) => onChange(setSpec(draft, { runtime: e.target.value as SourceSpec['runtime'] }))}>
              <option value="remote">Remote (URL)</option>
              <option value="npm">npm package</option>
              <option value="python">Python (PyPI)</option>
              <option value="oci">Container image</option>
            </Select>
          )}
        </Field>
        {s.runtime === 'remote' ? (
          <Field label="Server URL" className="sm:col-span-2">
            {({ id }) => <Input id={id} disabled={readOnly} value={s.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => onChange(setSpec(draft, { url: e.target.value }))} />}
          </Field>
        ) : (
          <>
            <Field label="Package">
              {({ id }) => <Input id={id} disabled={readOnly} value={s.package} placeholder="@acme/pg-mcp" onChange={(e) => onChange(setSpec(draft, { package: e.target.value }))} />}
            </Field>
            <Field label="Version" help="Pinned to the exact version">
              {({ id }) => <Input id={id} disabled={readOnly} value={s.version} placeholder="3.2.0" onChange={(e) => onChange(setSpec(draft, { version: e.target.value }))} />}
            </Field>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-md bg-sunken p-3.5">
        <Field label="Import from a client config or server.json" error={importError}>
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} className="min-h-20 font-mono text-[12px]" value={paste} placeholder={'{ "command": "npx", "args": ["-y", "@acme/pg-mcp@3.2.0"] }'} onChange={(e) => setPaste(e.target.value)} />
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
            onChange(setSpec(draft, { runtime: r.runtime, package: r.package, version: r.version, command: r.command, args: r.args, url: r.url }));
          }}
        >
          Import
        </Button>
      </div>
    </Card>
  );
}

export function ConfigurationStep({ draft, onChange, readOnly }: Props) {
  const vars = draft.spec.variables;
  const update = (i: number, patch: Partial<SourceSpec['variables'][number]>) =>
    onChange(setSpec(draft, { variables: vars.map((v, k) => (k === i ? { ...v, ...patch } : v)) }));
  return (
    <Card aria-label="Configuration" className="gap-4">
      <CardHeader
        title="Configuration"
        subtitle="Variables people fill in when they install"
        actions={
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => onChange(setSpec(draft, { variables: [...vars, { name: '', label: '', required: true, secret: false, default: '' }] }))}>
            <Plus className="size-4" aria-hidden="true" />
            Add variable
          </Button>
        }
      />
      {vars.length === 0 ? <p className="m-0 text-muted">No variables: people can install without filling anything in.</p> : null}
      {vars.map((v, i) => (
        <fieldset key={i} className="m-0 grid items-end gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto_auto]">
          <legend className="sr-only">Variable {i + 1}</legend>
          <Field label="Name">{({ id }) => <Input id={id} disabled={readOnly} value={v.name} onChange={(e) => update(i, { name: e.target.value })} />}</Field>
          <Field label="Label">{({ id }) => <Input id={id} disabled={readOnly} value={v.label} onChange={(e) => update(i, { label: e.target.value })} />}</Field>
          <Field label="Default">{({ id }) => <Input id={id} disabled={readOnly || v.secret} value={v.default} onChange={(e) => update(i, { default: e.target.value })} />}</Field>
          <label className="flex h-11 items-center gap-2 text-[13px]"><input type="checkbox" disabled={readOnly} checked={v.required} onChange={(e) => update(i, { required: e.target.checked })} />Required</label>
          <label className="flex h-11 items-center gap-2 text-[13px]"><input type="checkbox" disabled={readOnly} checked={v.secret} onChange={(e) => update(i, { secret: e.target.checked })} />Secret</label>
          <Button variant="ghost" size="icon-sm" aria-label={`Remove variable ${v.name || i + 1}`} disabled={readOnly} onClick={() => onChange(setSpec(draft, { variables: vars.filter((_, k) => k !== i) }))}>
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </fieldset>
      ))}
    </Card>
  );
}

const AUTH_OPTIONS: { value: AuthMode; label: string; help: string }[] = [
  { value: 'oauth', label: 'OAuth', help: 'Each person signs in to the upstream' },
  { value: 'userSecret', label: 'Personal API key', help: 'Each person adds their own key' },
  { value: 'teamSecret', label: 'Shared team secret', help: 'One secret for the owning team' },
  { value: 'none', label: 'None', help: 'The server needs no credentials' },
];

export function AuthenticationStep({ draft, onChange, readOnly }: Props) {
  return (
    <Card aria-label="Authentication" className="gap-4">
      <CardHeader title="Authentication" subtitle="How Bastion signs in to the server" />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Authentication mode</legend>
        {AUTH_OPTIONS.map((o) => (
          <label key={o.value} className={`flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 ${draft.spec.authMode === o.value ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}>
            <input type="radio" name="auth" disabled={readOnly} checked={draft.spec.authMode === o.value} onChange={() => onChange(setSpec(draft, { authMode: o.value }))} className="size-[18px] accent-[var(--tangerine-ink)]" />
            <span className="flex-1 text-label">{o.label}</span>
            <span className="text-caption text-muted">{o.help}</span>
          </label>
        ))}
      </fieldset>
      {draft.spec.authMode === 'oauth' ? (
        <Field label="OAuth scopes" help="Space separated">
          {({ id }) => <Input id={id} disabled={readOnly} value={draft.spec.oauthScopes.join(' ')} onChange={(e) => onChange(setSpec(draft, { oauthScopes: e.target.value.split(/\s+/).filter(Boolean) }))} />}
        </Field>
      ) : null}
    </Card>
  );
}

export function NetworkStep({ draft, onChange, readOnly }: Props) {
  const [host, setHost] = React.useState('');
  const hosts = draft.spec.egressHosts;
  const add = () => {
    const h = host.trim().toLowerCase();
    if (h && !hosts.includes(h)) onChange(setSpec(draft, { egressHosts: [...hosts, h] }));
    setHost('');
  };
  return (
    <Card aria-label="Network" className="gap-4">
      <CardHeader title="Network" subtitle="The only places this server may connect (egress allowlist)" />
      <div className="flex flex-wrap gap-1.5" aria-label="Allowed hosts">
        {hosts.length === 0 ? <span className="text-caption text-muted">No outbound access.</span> : null}
        {hosts.map((h) => (
          <Chip key={h} onRemove={readOnly ? undefined : () => onChange(setSpec(draft, { egressHosts: hosts.filter((x) => x !== h) }))} removeLabel={`Remove ${h}`}>{h}</Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <Field label="Add a host" className="flex-1">
          {({ id }) => <Input id={id} disabled={readOnly} value={host} placeholder="api.example.com" onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />}
        </Field>
        <Button variant="outline" className="self-end" disabled={readOnly || !host.trim()} onClick={add}>Add</Button>
      </div>
      {draft.spec.runtime !== 'remote' ? (
        <Field label="Isolation">
          {({ id }) => (
            <Select id={id} disabled={readOnly} value={draft.spec.isolation} onChange={(e) => onChange(setSpec(draft, { isolation: e.target.value as SourceSpec['isolation'] }))}>
              <option value="gvisor">gVisor sandbox</option>
              <option value="namespaces">Namespaces</option>
              <option value="none">None</option>
            </Select>
          )}
        </Field>
      ) : null}
    </Card>
  );
}

export function OverridesStep({ draft, onChange, readOnly }: Props) {
  const [text, setText] = React.useState(() => JSON.stringify(draft.spec.overrides, null, 2));
  const v = validateOverrideText(text);
  const schema = React.useMemo(() => overrideJsonSchema(), []);
  return (
    <Card aria-label="Overrides" className="gap-4">
      <CardHeader title="Overrides" subtitle="The default overrides every installation starts from" />
      <CodeEditor language="json" ariaLabel="Default override document" height={280} value={text} readOnly={readOnly ?? false} jsonSchema={schema}
        onChange={(t) => { setText(t); const r = validateOverrideText(t); if (r.ok) onChange(setSpec(draft, { overrides: r.document })); }} />
      {v.ok ? <p className="m-0 text-caption font-medium text-mint-ink">Valid override document.</p> : (
        <ul role="alert" className="m-0 list-disc rounded-md bg-coral-soft py-3 pl-8 pr-3 text-[13px] text-coral-ink">
          {v.issues.map((i) => <li key={`${i.path}${i.message}`}>{i.path ? `${i.path}: ` : ''}{i.message}</li>)}
        </ul>
      )}
      <Field label="What may people override on their installs?">
        {({ id }) => (
          <Select id={id} disabled={readOnly} value={draft.spec.userOverrides} onChange={(e) => onChange(setSpec(draft, { userOverrides: e.target.value as SourceSpec['userOverrides'] }))}>
            <option value="none">Nothing</option>
            <option value="cosmetic">Cosmetic: hide, rename, title, description</option>
            <option value="full">Full: also arguments and schema</option>
          </Select>
        )}
      </Field>
    </Card>
  );
}

export function SecurityStep({ draft, onChange, readOnly }: Props) {
  const { role } = useAuth();
  return (
    <Card aria-label="Security and limits" className="gap-4">
      <CardHeader title="Security and limits" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Guard profile" help="Empty uses the org default">
          {({ id }) => <Input id={id} disabled={readOnly} value={draft.spec.guardProfileId ?? ''} onChange={(e) => onChange(setSpec(draft, { guardProfileId: e.target.value || null }))} />}
        </Field>
        <Field label="Limits profile">
          {({ id }) => <Input id={id} disabled={readOnly} value={draft.spec.limitsProfile} onChange={(e) => onChange(setSpec(draft, { limitsProfile: e.target.value }))} />}
        </Field>
        <Field label="When a tool definition changes" help="Rug-pull protection (13.6)">
          {({ id }) => (
            <Select id={id} disabled={readOnly} value={draft.spec.onDrift} onChange={(e) => onChange(setSpec(draft, { onDrift: e.target.value as SourceSpec['onDrift'] }))}>
              <option value="hideChanged">Hide changed tools until approved</option>
              <option value="block">Block the whole installation</option>
              <option value="warn">Warn only</option>
            </Select>
          )}
        </Field>
        {role === 'admin' ? (
          <Field label="Risk" help="Available to Cedar rules">
            {({ id }) => (
              <Select id={id} disabled={readOnly} value={draft.risk} onChange={(e) => onChange({ ...draft, risk: e.target.value as Draft['risk'] })}>
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

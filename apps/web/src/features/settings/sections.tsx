import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { type FieldPath, type FieldValues, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { orgSettingsSchema } from '@bastion-mcp/core/org-settings';
import {
  useDeleteLimitRule,
  useIdpConnections,
  useLimitRules,
  useModelGuards,
  usePatchSettings,
  useRotateKms,
  useSaveIdp,
  useSaveLimitRule,
  useSaveModelGuards,
  useSettings,
  useSystemStatus,
  useTestIdp,
} from '@/api/hooks';
import type { IdpConnection, IdpTestResult, LimitRule, ModelGuardConfig, OrgSettings } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatDate } from '@/lib/format';

/** One settings card: loads `/settings`, edits a slice with a zod-validated form and PATCHes only that slice. */
function useSection<T extends FieldValues>(key: 'org' | 'sandbox', schema: z.ZodType<T>) {
  const settings = useSettings();
  const patch = usePatchSettings();
  const form = useForm<T>({
    resolver: zodResolver(schema as never) as never,
    values: settings.data?.[key] as unknown as T,
  });
  const submit = form.handleSubmit((v) =>
    patch.mutateAsync({ [key]: v } as Partial<OrgSettings>).then(() => toast.success('Settings saved')),
  );
  return { settings, patch, form, submit };
}

const shape = orgSettingsSchema.shape;
export function OrganizationSection() {
  const org = useSection<OrgSettings['org']>('org', shape.org);
  const settings = useSettings();
  const patch = usePatchSettings();
  const personal = useForm<{ personalInstalls: OrgSettings['personalInstalls']; toolWarnThreshold: number }>({
    values: settings.data ? { personalInstalls: settings.data.personalInstalls, toolWarnThreshold: settings.data.endpoints.toolWarnThreshold } : undefined,
  });
  return (
    <QueryBoundary query={org.settings}>
      {() => (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card aria-label="Organization" className="gap-4">
            <CardHeader title="Organization" />
            <form noValidate className="flex flex-col gap-4" onSubmit={org.submit}>
              <Field label="Display name" required error={org.form.formState.errors.displayName?.message}>
                {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...org.form.register('displayName')} />}
              </Field>
              <Field label="Time zone" error={org.form.formState.errors.timeZone?.message} help="Used for schedules and report boundaries">
                {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...org.form.register('timeZone')} />}
              </Field>
              <Button type="submit" disabled={org.patch.isPending}>Save organization</Button>
            </form>
          </Card>
          <Card aria-label="Installs and endpoints" className="gap-4">
            <CardHeader title="Installs and endpoints" />
            <form className="flex flex-col gap-4" onSubmit={personal.handleSubmit((v) => patch.mutateAsync({ personalInstalls: v.personalInstalls, endpoints: { toolWarnThreshold: Number(v.toolWarnThreshold) } }).then(() => toast.success('Settings saved')))}>
              <Field label="Personal installs" help="Servers people add without the catalog">
                {({ id }) => <Select id={id} {...personal.register('personalInstalls')}><option value="off">Off</option><option value="remoteOnly">Remote servers only</option><option value="all">All kinds</option></Select>}
              </Field>
              <Field label="Warn above this many tools per endpoint">
                {({ id }) => <Input id={id} type="number" min={1} {...personal.register('toolWarnThreshold', { valueAsNumber: true })} />}
              </Field>
              <Button type="submit" disabled={patch.isPending}>Save</Button>
            </form>
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}

export function SandboxesSection() {
  const s = useSection<OrgSettings['sandbox']>('sandbox', shape.sandbox);
  return (
    <QueryBoundary query={s.settings}>
      {() => (
        <Card aria-label="Sandboxes" className="max-w-2xl gap-4">
          <CardHeader title="Sandboxes" />
          <form noValidate className="flex flex-col gap-4" onSubmit={s.submit}>
            <Field label="Default size">{({ id }) => <Select id={id} {...s.form.register('defaultSize')}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></Select>}</Field>
            <fieldset className="m-0 grid gap-4 border-0 p-0 sm:grid-cols-3">
              <legend className="mb-1.5 text-[13px] font-medium">Warm pool (idle sandboxes kept ready)</legend>
              {(['small', 'medium', 'large'] as const).map((k) => (
                <Field key={k} label={k[0]?.toUpperCase() + k.slice(1)}>{({ id }) => <Input id={id} type="number" min={0} {...s.form.register(`warmPool.${k}` as FieldPath<OrgSettings['sandbox']>, { valueAsNumber: true })} />}</Field>
              ))}
            </fieldset>
            <Field label="Idle timeout (minutes)" error={s.form.formState.errors.idleTimeoutMinutes?.message}>
              {({ id, describedBy, invalid }) => <Input id={id} type="number" aria-describedby={describedBy} aria-invalid={invalid} {...s.form.register('idleTimeoutMinutes', { valueAsNumber: true })} />}
            </Field>
            <Button type="submit" disabled={s.patch.isPending}>Save sandboxes</Button>
          </form>
        </Card>
      )}
    </QueryBoundary>
  );
}

const retentionSchema = z.object({
  logsRetentionDays: z.number().int().positive(),
  capturePreviews: z.boolean(),
  managerVisibility: z.boolean(),
  auditRetentionDays: z.number().int().positive(),
  webhookUrl: z.string().url('Enter a full URL').or(z.literal('')),
});
type RetentionValues = z.infer<typeof retentionSchema>;

export function RetentionSection() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const form = useForm<RetentionValues>({
    resolver: zodResolver(retentionSchema),
    values: settings.data ? { logsRetentionDays: settings.data.logs.retentionDays, capturePreviews: settings.data.logs.capturePreviews, managerVisibility: settings.data.logs.managerVisibility, auditRetentionDays: settings.data.audit.retentionDays, webhookUrl: settings.data.audit.webhookUrl ?? '' } : undefined,
  });
  return (
    <QueryBoundary query={settings}>
      {() => (
        <Card aria-label="Retention" className="max-w-2xl gap-4">
          <CardHeader title="Retention and privacy" />
          <form noValidate className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => patch.mutateAsync({ logs: { retentionDays: v.logsRetentionDays, capturePreviews: v.capturePreviews, managerVisibility: v.managerVisibility }, audit: { retentionDays: v.auditRetentionDays, webhookUrl: v.webhookUrl || null } }).then(() => toast.success('Retention saved')))}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Call log (days)" error={form.formState.errors.logsRetentionDays?.message}>{({ id }) => <Input id={id} type="number" {...form.register('logsRetentionDays', { valueAsNumber: true })} />}</Field>
              <Field label="Audit log (days)" error={form.formState.errors.auditRetentionDays?.message}>{({ id }) => <Input id={id} type="number" {...form.register('auditRetentionDays', { valueAsNumber: true })} />}</Field>
            </div>
            <label className="flex items-center gap-3"><Switch checked={form.watch('capturePreviews')} onCheckedChange={(v) => form.setValue('capturePreviews', v, { shouldDirty: true })} /><span><span className="block text-label">Keep redacted previews</span><span className="block text-caption text-muted">Stores 2 KiB of each call’s arguments and result.</span></span></label>
            <label className="flex items-center gap-3"><Switch checked={form.watch('managerVisibility')} onCheckedChange={(v) => form.setValue('managerVisibility', v, { shouldDirty: true })} /><span className="text-label">Managers see their team’s calls</span></label>
            <Field label="Audit webhook (optional)" error={form.formState.errors.webhookUrl?.message}>{({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="https://siem.example.com/hook" {...form.register('webhookUrl')} />}</Field>
            <Button type="submit" disabled={patch.isPending}>Save retention</Button>
          </form>
        </Card>
      )}
    </QueryBoundary>
  );
}

function IdpTest({ result }: { result: IdpTestResult }) {
  return (
    <ul aria-label="Connection test" className="m-0 flex list-none flex-col gap-1.5 rounded-md bg-sunken p-3 text-[13px]">
      {result.steps.map((s) => (
        <li key={s.name} className="flex items-center gap-2"><StatusDot tone={s.ok ? 'ok' : 'bad'} label={s.ok ? 'Passed' : 'Failed'} hideLabel /><span className="font-medium">{s.name}</span><span className="text-muted">{s.detail}</span></li>
      ))}
    </ul>
  );
}

export function IdpSection() {
  const q = useIdpConnections();
  const test = useTestIdp();
  const save = useSaveIdp();
  const [results, setResults] = React.useState<Record<string, IdpTestResult>>({});
  const [editing, setEditing] = React.useState<IdpConnection | 'new' | null>(null);
  const [draft, setDraft] = React.useState({ name: '', issuer: '', clientId: '', clientSecret: '', scopes: 'openid email profile', domains: '' });
  React.useEffect(() => {
    if (editing === 'new') setDraft({ name: '', issuer: '', clientId: '', clientSecret: '', scopes: 'openid email profile', domains: '' });
    else if (editing) setDraft({ name: editing.name, issuer: editing.issuer, clientId: editing.clientId, clientSecret: '', scopes: editing.scopes.join(' '), domains: editing.domains.join(', ') });
  }, [editing]);
  return (
    <Card aria-label="Identity providers" className="gap-3">
      <CardHeader title="Identity providers" subtitle="OIDC connections for sign-in" actions={<Button size="sm" onClick={() => setEditing('new')}>Add connection</Button>} />
      <QueryBoundary query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No identity provider" description="Add an OIDC connection so people can sign in with your IdP." action={{ label: 'Add connection', onClick: () => setEditing('new') }} />}>
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1"><div className="text-label">{c.name}</div><div className="truncate font-mono text-caption text-muted">{c.issuer}</div></div>
                  <StatusDot tone={c.status === 'ok' ? 'ok' : c.status === 'error' ? 'bad' : 'neutral'} label={c.status === 'ok' ? 'Working' : c.status === 'error' ? 'Failing' : 'Not tested'} />
                  {c.lastTestAt ? <span className="text-caption text-muted">tested {formatDate(c.lastTestAt)}</span> : null}
                  <Button variant="outline" size="xs" disabled={test.isPending} onClick={() => test.mutate(c.id, { onSuccess: (r) => setResults((x) => ({ ...x, [c.id]: r })) })}>Test connection</Button>
                  <Button variant="ghost" size="xs" onClick={() => setEditing(c)}>Edit</Button>
                </div>
                {results[c.id] ? <IdpTest result={results[c.id] as IdpTestResult} /> : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'Add identity provider' : 'Edit identity provider'}>
          <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...(editing && editing !== 'new' ? { id: editing.id } : {}), idp: { name: draft.name, issuer: draft.issuer, clientId: draft.clientId, scopes: draft.scopes.split(/\s+/).filter(Boolean), domains: draft.domains.split(',').map((d) => d.trim()).filter(Boolean), ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}) } }, { onSuccess: () => { toast.success('Connection saved'); setEditing(null); } }); }}>
            <Field label="Name" required>{({ id }) => <Input id={id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
            <Field label="Issuer (discovery URL base)" required>{({ id }) => <Input id={id} value={draft.issuer} placeholder="https://acme.okta.com" onChange={(e) => setDraft({ ...draft, issuer: e.target.value })} />}</Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Client ID" required>{({ id }) => <Input id={id} value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })} />}</Field>
              <Field label="Client secret" help="Leave empty to keep the current one">{({ id }) => <Input id={id} type="password" autoComplete="new-password" value={draft.clientSecret} onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })} />}</Field>
            </div>
            <Field label="Scopes">{({ id }) => <Input id={id} value={draft.scopes} onChange={(e) => setDraft({ ...draft, scopes: e.target.value })} />}</Field>
            <Field label="Allowed email domains" help="Comma separated">{({ id }) => <Input id={id} value={draft.domains} onChange={(e) => setDraft({ ...draft, domains: e.target.value })} />}</Field>
            <Button type="submit" disabled={!draft.name || !draft.issuer || !draft.clientId || save.isPending}>Save connection</Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function KmsSection() {
  const sys = useSystemStatus();
  const rotate = useRotateKms();
  const [confirm, setConfirm] = React.useState(false);
  return (
    <Card aria-label="Encryption keys" className="max-w-2xl gap-3.5">
      <CardHeader title="Encryption keys" />
      <QueryBoundary query={sys}>
        {(s) => (
          <>
            <div className="flex items-center gap-3 rounded-md bg-sunken p-3.5">
              <StatusDot tone={s.checks.find((c) => c.name === 'Key management')?.status === 'ok' ? 'ok' : 'warn'} label="Reachable" />
              <span className="flex-1 text-label">{s.kms.provider}</span>
              <span className="text-caption text-muted">rotated {formatDate(s.kms.rotatedAt)}</span>
            </div>
            <p className="m-0 text-muted">Secrets are envelope-encrypted. Rotating re-wraps data keys; nothing is shown or lost.</p>
            <Button variant="outline" className="self-start" onClick={() => setConfirm(true)}>Rotate keys</Button>
            <Dialog open={confirm} onOpenChange={setConfirm}>
              <DialogContent title="Rotate encryption keys?" description="This re-wraps every data key with a new key version.">
                <div className="flex gap-2">
                  <Button disabled={rotate.isPending} onClick={() => rotate.mutate(undefined, { onSuccess: () => { toast.success('Key rotation started'); setConfirm(false); } })}>Rotate</Button>
                  <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

const GUARD_LABELS: Record<keyof ModelGuardConfig, { title: string; help: string }> = {
  jev: { title: 'JEV guard', help: 'Judges tool results for injected instructions' },
  llmJudge: { title: 'LLM judge', help: 'A general model scores risky calls' },
  classifier: { title: 'Classifier', help: 'A small model labels content' },
};

export function ModelGuardsSection() {
  const q = useModelGuards();
  const save = useSaveModelGuards();
  const [cfg, setCfg] = React.useState<ModelGuardConfig | null>(null);
  React.useEffect(() => { if (q.data) setCfg(q.data); }, [q.data]);
  return (
    <QueryBoundary query={q}>
      {() =>
        cfg ? (
          <Card aria-label="Model guards" className="max-w-3xl gap-4">
            <CardHeader title="Model guards" subtitle="Optional models that add judgement to the deterministic guards" />
            {(Object.keys(GUARD_LABELS) as (keyof ModelGuardConfig)[]).map((k) => (
              <fieldset key={k} className="m-0 flex flex-col gap-3 rounded-md border border-line p-3.5">
                <legend className="px-1 text-label">{GUARD_LABELS[k].title}</legend>
                <label className="flex items-center gap-3"><Switch checked={cfg[k].enabled} onCheckedChange={(v) => setCfg({ ...cfg, [k]: { ...cfg[k], enabled: v } })} aria-label={`Enable ${GUARD_LABELS[k].title}`} /><span className="text-caption text-muted">{GUARD_LABELS[k].help}</span></label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Endpoint">{({ id }) => <Input id={id} disabled={!cfg[k].enabled} value={cfg[k].endpoint} onChange={(e) => setCfg({ ...cfg, [k]: { ...cfg[k], endpoint: e.target.value } })} />}</Field>
                  <Field label="Model">{({ id }) => <Input id={id} disabled={!cfg[k].enabled} value={cfg[k].model} onChange={(e) => setCfg({ ...cfg, [k]: { ...cfg[k], model: e.target.value } })} />}</Field>
                </div>
              </fieldset>
            ))}
            <Button className="self-start" disabled={save.isPending} onClick={() => save.mutate(cfg, { onSuccess: () => toast.success('Model guards saved') })}>Save model guards</Button>
          </Card>
        ) : null
      }
    </QueryBoundary>
  );
}

const limitSchema = z.object({
  name: z.string().trim().min(1, 'Name the rule'),
  kind: z.enum(['rate', 'quota', 'concurrency']),
  scope: z.string().trim().min(1, 'Say who it applies to'),
  limit: z.number().int().positive('Must be above zero'),
  window: z.string().trim().min(1),
});
type LimitValues = z.infer<typeof limitSchema>;

export function LimitsSection() {
  const q = useLimitRules();
  const save = useSaveLimitRule();
  const del = useDeleteLimitRule();
  const [editing, setEditing] = React.useState<LimitRule | 'new' | null>(null);
  const form = useForm<LimitValues>({ resolver: zodResolver(limitSchema), defaultValues: { name: '', kind: 'quota', scope: 'Every user', limit: 1000, window: 'per day' } });
  React.useEffect(() => {
    if (editing === 'new') form.reset({ name: '', kind: 'quota', scope: 'Every user', limit: 1000, window: 'per day' });
    else if (editing) form.reset(editing);
  }, [editing, form]);
  return (
    <Card aria-label="Limits" className="gap-3">
      <CardHeader title="Limits" subtitle="Rate, quota and concurrency rules (14)" actions={<Button size="sm" onClick={() => setEditing('new')}>Add rule</Button>} />
      <QueryBoundary query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No limits" description="Defaults apply until you add a rule." action={{ label: 'Add rule', onClick: () => setEditing('new') }} />}>
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
                <span className="flex-1 text-label">{r.name}</span>
                <Tag>{r.kind}</Tag>
                <span className="text-caption text-muted">{r.scope} · {r.limit.toLocaleString()} {r.window}</span>
                <Button variant="ghost" size="xs" onClick={() => setEditing(r)}>Edit</Button>
                <Button variant="ghost" size="xs" onClick={() => del.mutate(r.id)}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'New limit' : 'Edit limit'}>
          <form noValidate className="flex flex-col gap-3.5" onSubmit={form.handleSubmit((v) => save.mutate({ ...(editing && editing !== 'new' ? { id: editing.id } : {}), rule: v }, { onSuccess: () => { toast.success('Limit saved'); setEditing(null); } }))}>
            <Field label="Name" error={form.formState.errors.name?.message}>{({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />}</Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Kind">{({ id }) => <Select id={id} {...form.register('kind')}><option value="rate">Rate</option><option value="quota">Quota</option><option value="concurrency">Concurrency</option></Select>}</Field>
              <Field label="Applies to" error={form.formState.errors.scope?.message}>{({ id }) => <Input id={id} {...form.register('scope')} />}</Field>
              <Field label="Limit" error={form.formState.errors.limit?.message}>{({ id }) => <Input id={id} type="number" {...form.register('limit', { valueAsNumber: true })} />}</Field>
              <Field label="Window">{({ id }) => <Input id={id} {...form.register('window')} />}</Field>
            </div>
            <Button type="submit" disabled={save.isPending}>Save limit</Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


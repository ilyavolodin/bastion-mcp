import { Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useAutoInstallPolicies,
  useCatalog,
  useDeleteAutoInstall,
  usePreviewAutoInstall,
  useSaveAutoInstall,
  useTeams,
} from '@/api/hooks';
import type { AutoInstallInput, AutoInstallPolicy, AutoInstallPreview, TargetChip } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { AvatarStrip, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';

/** "412 people in 6 teams get this; 38 must connect their account" with an avatar strip (11.5, 18.3). */
export function PreviewSummary({ preview }: { preview: AutoInstallPreview | undefined; loading?: boolean }) {
  if (!preview) return <p className="m-0 text-muted">Pick who gets it to see the effect before saving.</p>;
  return (
    <div className="flex flex-col gap-2.5">
      <AvatarStrip names={preview.sample.map((s) => s.name)} extra={Math.max(0, preview.people - preview.sample.length)} />
      <p className="m-0">
        <strong className="font-semibold">
          {preview.people} people in {preview.teams} {preview.teams === 1 ? 'team' : 'teams'}
        </strong>{' '}
        get this when you save.{' '}
        {preview.mustConnect > 0
          ? `${preview.mustConnect} must connect their account.`
          : 'None need to sign in; it uses a shared team secret.'}
      </p>
    </div>
  );
}

const ROLE_TARGETS = [
  { id: 'member', label: 'Role · Member' },
  { id: 'auditor', label: 'Role · Auditor' },
  { id: 'admin', label: 'Role · Admin' },
];

export function PolicyDialog({
  open,
  onOpenChange,
  policy,
  entryId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policy: AutoInstallPolicy | null;
  entryId?: string | undefined;
}) {
  const catalog = useCatalog({ kind: 'mcp_server' });
  const teams = useTeams();
  const save = useSaveAutoInstall();
  const preview = usePreviewAutoInstall();
  const [entry, setEntry] = React.useState(policy?.entryId ?? entryId ?? '');
  const [targets, setTargets] = React.useState<TargetChip[]>(policy?.targets ?? []);
  const [mode, setMode] = React.useState<'required' | 'default'>(policy?.mode ?? 'default');
  const [existing, setExisting] = React.useState<'applyNow' | 'newOnly'>(policy?.existingUsers ?? 'applyNow');
  const [scope, setScope] = React.useState<'user' | 'team'>(policy?.scope ?? 'user');
  const [group, setGroup] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  React.useEffect(() => {
    if (open) {
      setEntry(policy?.entryId ?? entryId ?? '');
      setTargets(policy?.targets ?? []);
      setMode(policy?.mode ?? 'default');
      setExisting(policy?.existingUsers ?? 'applyNow');
      setScope(policy?.scope ?? 'user');
      setError(undefined);
    }
  }, [open, policy, entryId]);

  const input: AutoInstallInput = { entryId: entry, targets, mode, existingUsers: existing, scope };
  const { mutate: runPreview } = preview;
  React.useEffect(() => {
    if (!open || targets.length === 0) return;
    const t = setTimeout(() => runPreview({ ...(policy ? { id: policy.id } : {}), policy: { entryId: entry, targets, mode, existingUsers: existing, scope } }), 250);
    return () => clearTimeout(t);
  }, [open, targets, entry, mode, existing, scope, policy, runPreview]);

  const add = (c: TargetChip) => setTargets((t) => (t.some((x) => x.type === c.type && x.id === c.id) ? t : [...t, c]));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!entry) return setError('Pick the entry to install');
    if (targets.length === 0) return setError('Pick at least one target');
    save.mutate({ ...(policy ? { id: policy.id } : {}), policy: input }, { onSuccess: () => { toast.success('Policy saved'); onOpenChange(false); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={policy ? 'Edit auto-install policy' : 'New auto-install policy'} description="Put a published entry into people’s accounts." className="sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Entry" required>
            {({ id }) => (
              <Select id={id} value={entry} onChange={(e) => setEntry(e.target.value)}>
                <option value="">Choose an entry</option>
                {(catalog.data ?? []).filter((c) => c.status === 'published' || c.id === entry).map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Who gets it</span>
            <div className="flex flex-wrap gap-1.5" aria-label="Targets">
              {targets.length === 0 ? <span className="text-caption text-muted">No targets yet</span> : null}
              {targets.map((t) => (
                <Chip key={`${t.type}-${t.id}`} tone="info" onRemove={() => setTargets((x) => x.filter((y) => y !== t))} removeLabel={`Remove ${t.label}`}>
                  {t.label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="xs" onClick={() => add({ type: 'all', id: 'all', label: 'Everyone' })}>Everyone</Button>
              <Select aria-label="Add a team" value="" className="h-9 w-auto text-[13px]" onChange={(e) => { const t = teams.data?.find((x) => x.id === e.target.value); if (t) add({ type: 'team', id: t.id, label: `Team · ${t.name}` }); }}>
                <option value="">+ Team</option>
                {(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              <Select aria-label="Add a role" value="" className="h-9 w-auto text-[13px]" onChange={(e) => { const r = ROLE_TARGETS.find((x) => x.id === e.target.value); if (r) add({ type: 'role', id: r.id, label: r.label }); }}>
                <option value="">+ Role</option>
                {ROLE_TARGETS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
              <Input aria-label="Add an IdP group" placeholder="+ IdP group" value={group} className="h-9 w-36 text-[13px]" onChange={(e) => setGroup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && group.trim()) { e.preventDefault(); add({ type: 'idpGroup', id: group.trim(), label: `Group · ${group.trim()}` }); setGroup(''); } }} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Mode">
              {({ id }) => (
                <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as 'required' | 'default')}>
                  <option value="default">Default (can be removed)</option>
                  <option value="required">Required</option>
                </Select>
              )}
            </Field>
            <Field label="Existing users">
              {({ id }) => (
                <Select id={id} value={existing} onChange={(e) => setExisting(e.target.value as 'applyNow' | 'newOnly')}>
                  <option value="applyNow">Apply now</option>
                  <option value="newOnly">Only new users</option>
                </Select>
              )}
            </Field>
            <Field label="Scope">
              {({ id }) => (
                <Select id={id} value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'team')}>
                  <option value="user">One per person</option>
                  <option value="team">One per team</option>
                </Select>
              )}
            </Field>
          </div>
          <div aria-live="polite" className="rounded-md bg-sunken p-3.5">
            <PreviewSummary preview={targets.length ? preview.data : undefined} />
          </div>
          {error ? <p role="alert" className="m-0 text-caption font-medium text-coral-ink">{error}</p> : null}
          <Button type="submit" disabled={save.isPending}>Save policy</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AutoInstallPanel() {
  const q = useAutoInstallPolicies();
  const del = useDeleteAutoInstall();
  const [editing, setEditing] = React.useState<AutoInstallPolicy | 'new' | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-muted">Policies that put a published entry into people’s accounts when they join, or now.</p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New policy
        </Button>
      </div>
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState title="No auto-install policies" description="Without a policy, people find servers in the Store themselves." action={{ label: 'New policy', onClick: () => setEditing('new') }} />}
      >
        {(items) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((p) => (
              <Card key={p.id} aria-label={p.entryName}>
                <CardHeader title={p.entryName} actions={<Tag tone={p.mode === 'required' ? 'warn' : 'neutral'}>{p.mode === 'required' ? 'Required' : 'Default'}</Tag>} />
                <div className="flex flex-wrap gap-1.5">
                  {p.targets.map((t) => <Chip key={`${t.type}-${t.id}`} tone="info">{t.label}</Chip>)}
                  <Chip>{p.existingUsers === 'applyNow' ? 'New and existing people' : 'New people only'}</Chip>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(p.id, { onSuccess: () => toast.success('Policy removed') })}>Remove</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
      <PolicyDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} policy={editing === 'new' ? null : editing} />
    </div>
  );
}

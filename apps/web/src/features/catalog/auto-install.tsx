import { Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useAutoInstallPolicies,
  useCatalog,
  useDeleteAutoInstall,
  usePreviewAutoInstall,
  useSaveAutoInstall,
  useTeamOptions,
} from '@/api/hooks';
import type { AutoInstallPreview, AutoInstallView, TargetChip } from '@/api/views/catalog';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { AvatarStrip, Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  emptyPolicyForm,
  formOf,
  type PolicyForm,
  policyError,
  TARGET_ROLES,
  toPolicyCreateBody,
  toPolicyPatchBody,
} from './policy-form';

/** "412 people in 6 teams get this; 38 must connect their account" with an avatar strip (11.5, 18.3). */
export function PreviewSummary({
  preview,
  hint = 'Pick who gets it to see the effect before saving.',
}: {
  preview: AutoInstallPreview | undefined;
  hint?: string;
}) {
  if (!preview) return <p className="m-0 text-muted">{hint}</p>;
  return (
    <div className="flex flex-col gap-2.5">
      <AvatarStrip
        names={preview.sample.map((s) => s.displayName)}
        extra={Math.max(0, preview.users - preview.sample.length)}
      />
      <p className="m-0">
        <strong className="font-semibold">
          {preview.users} people in {preview.teams} {preview.teams === 1 ? 'team' : 'teams'}
        </strong>{' '}
        get this when you save.{' '}
        {preview.mustConnect > 0
          ? `${preview.mustConnect} must connect their account.`
          : 'None need to sign in; it uses a shared secret.'}
      </p>
    </div>
  );
}

const roleChip = (role: string): TargetChip => ({
  type: 'role',
  id: role,
  label: `Role · ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
});

export function PolicyDialog({
  open,
  onOpenChange,
  policy,
  entryId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policy: AutoInstallView | null;
  entryId?: string | undefined;
}) {
  const catalog = useCatalog({ kind: 'mcp_server' });
  const teams = useTeamOptions();
  const save = useSaveAutoInstall();
  const preview = usePreviewAutoInstall();
  const [form, setForm] = React.useState<PolicyForm>(() =>
    policy ? formOf(policy) : emptyPolicyForm(entryId),
  );
  const [group, setGroup] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  React.useEffect(() => {
    if (open) {
      setForm(policy ? formOf(policy) : emptyPolicyForm(entryId));
      setError(undefined);
    }
  }, [open, policy, entryId]);

  // The API previews a stored policy with unsaved changes, so only an existing policy has a live preview.
  const { mutate: runPreview } = preview;
  const policyId = policy?.id;
  React.useEffect(() => {
    if (!open || !policyId || form.targets.length === 0) return;
    const t = setTimeout(() => {
      const body = toPolicyPatchBody(form);
      runPreview({
        id: policyId,
        changes: {
          target: body.target,
          mode: body.mode,
          scope: body.scope,
          applyToExisting: body.applyToExisting,
        },
      });
    }, 250);
    return () => clearTimeout(t);
  }, [open, form, policyId, runPreview]);

  const set = (patch: Partial<PolicyForm>) => setForm((f) => ({ ...f, ...patch }));
  const add = (c: TargetChip) =>
    set({
      targets: form.targets.some((x) => x.type === c.type && x.id === c.id)
        ? form.targets
        : [...form.targets, c],
    });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = policyError(form);
    if (problem) return setError(problem);
    setError(undefined);
    const done = {
      onSuccess: () => {
        toast.success('Policy saved');
        onOpenChange(false);
      },
    };
    if (policy) save.mutate({ id: policy.id, policy: toPolicyPatchBody(form) }, done);
    else save.mutate({ policy: toPolicyCreateBody(form) }, done);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={policy ? 'Edit auto-install policy' : 'New auto-install policy'}
        description="Put a published entry into people’s accounts."
        className="sm:max-w-xl"
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Entry" required>
            {({ id }) => (
              <Select
                id={id}
                value={form.entryId}
                disabled={Boolean(policy)}
                onChange={(e) => set({ entryId: e.target.value })}
              >
                <option value="">Choose an entry</option>
                {(catalog.data ?? [])
                  .filter((c) => c.status === 'published' || c.id === form.entryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Who gets it</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Targets">
              {form.targets.length === 0 ? (
                <span className="text-caption text-muted">No targets yet</span>
              ) : null}
              {form.targets.map((t) => (
                <Chip
                  key={`${t.type}-${t.id}`}
                  tone="info"
                  onRemove={() => set({ targets: form.targets.filter((y) => y !== t) })}
                  removeLabel={`Remove ${t.label}`}
                >
                  {t.label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => add({ type: 'all', id: 'all', label: 'Everyone' })}
              >
                Everyone
              </Button>
              <Select
                aria-label="Add a team"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) => {
                  const t = teams.data?.find((x) => x.id === e.target.value);
                  if (t) add({ type: 'team', id: t.id, label: `Team · ${t.name}` });
                }}
              >
                <option value="">+ Team</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Add a role"
                value=""
                className="h-9 w-auto text-[13px]"
                onChange={(e) => e.target.value && add(roleChip(e.target.value))}
              >
                <option value="">+ Role</option>
                {TARGET_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleChip(r).label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Add an IdP group"
                placeholder="+ IdP group"
                value={group}
                maxLength={256}
                className="h-9 w-36 text-[13px]"
                onChange={(e) => setGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && group.trim()) {
                    e.preventDefault();
                    add({ type: 'idpGroup', id: group.trim(), label: `Group · ${group.trim()}` });
                    setGroup('');
                  }
                }}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Mode">
              {({ id }) => (
                <Select
                  id={id}
                  value={form.mode}
                  onChange={(e) => set({ mode: e.target.value as PolicyForm['mode'] })}
                >
                  <option value="default">Default (can be removed)</option>
                  <option value="required">Required</option>
                </Select>
              )}
            </Field>
            <Field label="Existing users">
              {({ id }) => (
                <Select
                  id={id}
                  value={form.applyToExisting ? 'applyNow' : 'newOnly'}
                  onChange={(e) => set({ applyToExisting: e.target.value === 'applyNow' })}
                >
                  <option value="applyNow">Apply now</option>
                  <option value="newOnly">Only new users</option>
                </Select>
              )}
            </Field>
            <Field label="Scope">
              {({ id }) => (
                <Select
                  id={id}
                  value={form.scope}
                  onChange={(e) => set({ scope: e.target.value as PolicyForm['scope'] })}
                >
                  <option value="user">One per person</option>
                  <option value="team">One per team</option>
                </Select>
              )}
            </Field>
          </div>
          <label className="flex items-center gap-2.5 text-[14px]">
            <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
            Policy is active
          </label>
          <div aria-live="polite" className="rounded-md bg-sunken p-3.5">
            <PreviewSummary
              preview={form.targets.length ? preview.data : undefined}
              hint={
                policy
                  ? 'Pick who gets it to see the effect before saving.'
                  : 'Save the policy to see who it reaches.'
              }
            />
          </div>
          {error ? (
            <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={save.isPending}>
            Save policy
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AutoInstallPanel() {
  const q = useAutoInstallPolicies();
  const del = useDeleteAutoInstall();
  const [editing, setEditing] = React.useState<AutoInstallView | 'new' | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-muted">
          Policies that put a published entry into people’s accounts when they join, or now.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New policy
        </Button>
      </div>
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No auto-install policies"
            description="Without a policy, people find servers in the Store themselves."
            action={{ label: 'New policy', onClick: () => setEditing('new') }}
          />
        }
      >
        {(items) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((p) => (
              <Card key={p.id} aria-label={p.entryName}>
                <CardHeader
                  title={p.entryName}
                  actions={
                    <Tag tone={p.mode === 'required' ? 'warn' : 'neutral'}>
                      {p.mode === 'required' ? 'Required' : 'Default'}
                    </Tag>
                  }
                />
                <div className="flex flex-wrap gap-1.5">
                  {p.targets.map((t) => (
                    <Chip key={`${t.type}-${t.id}`} tone="info">
                      {t.label}
                    </Chip>
                  ))}
                  <Chip>{p.applyToExisting ? 'New and existing people' : 'New people only'}</Chip>
                  {p.enabled ? null : <Chip>Paused</Chip>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      del.mutate(p.id, { onSuccess: () => toast.success('Policy removed') })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
      <PolicyDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        policy={editing === 'new' ? null : editing}
      />
    </div>
  );
}

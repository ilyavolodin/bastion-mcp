import { orgSettingsSchema } from '@bastion-mcp/core/org-settings';
import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { type FieldPath, type FieldValues, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { usePatchSettings, useRotateKms, useSettings, useSystemStatus } from '@/api/hooks';
import type { OrgSettings } from '@/api/views/settings';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
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
    patch
      .mutateAsync({ [key]: v } as Partial<OrgSettings>)
      .then(() => toast.success('Settings saved')),
  );
  return { settings, patch, form, submit };
}

const shape = orgSettingsSchema.shape;
export function OrganizationSection() {
  const org = useSection<OrgSettings['org']>('org', shape.org);
  const settings = useSettings();
  const patch = usePatchSettings();
  const personal = useForm<{
    personalInstalls: OrgSettings['personalInstalls'];
    toolWarnThreshold: number;
  }>({
    values: settings.data
      ? {
          personalInstalls: settings.data.personalInstalls,
          toolWarnThreshold: settings.data.endpoints.toolWarnThreshold,
        }
      : undefined,
  });
  return (
    <QueryBoundary query={org.settings}>
      {() => (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card aria-label="Organization" className="gap-4">
            <CardHeader title="Organization" />
            <form noValidate className="flex flex-col gap-4" onSubmit={org.submit}>
              <Field
                label="Display name"
                required
                error={org.form.formState.errors.displayName?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...org.form.register('displayName')}
                  />
                )}
              </Field>
              <Field
                label="Time zone"
                error={org.form.formState.errors.timeZone?.message}
                help="Used for schedules and report boundaries"
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...org.form.register('timeZone')}
                  />
                )}
              </Field>
              <Button type="submit" disabled={org.patch.isPending}>
                Save organization
              </Button>
            </form>
          </Card>
          <Card aria-label="Installs and endpoints" className="gap-4">
            <CardHeader title="Installs and endpoints" />
            <form
              className="flex flex-col gap-4"
              onSubmit={personal.handleSubmit((v) =>
                patch
                  .mutateAsync({
                    personalInstalls: v.personalInstalls,
                    endpoints: { toolWarnThreshold: Number(v.toolWarnThreshold) },
                  })
                  .then(() => toast.success('Settings saved')),
              )}
            >
              <Field label="Personal installs" help="Servers people add without the catalog">
                {({ id }) => (
                  <Select id={id} {...personal.register('personalInstalls')}>
                    <option value="off">Off</option>
                    <option value="remoteOnly">Remote servers only</option>
                    <option value="all">All kinds</option>
                  </Select>
                )}
              </Field>
              <Field label="Warn above this many tools per endpoint">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    {...personal.register('toolWarnThreshold', { valueAsNumber: true })}
                  />
                )}
              </Field>
              <Button type="submit" disabled={patch.isPending}>
                Save
              </Button>
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
            <Field label="Default size">
              {({ id }) => (
                <Select id={id} {...s.form.register('defaultSize')}>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </Select>
              )}
            </Field>
            <fieldset className="m-0 grid gap-4 border-0 p-0 sm:grid-cols-3">
              <legend className="mb-1.5 text-[13px] font-medium">
                Warm pool (idle sandboxes kept ready)
              </legend>
              {(['small', 'medium', 'large'] as const).map((k) => (
                <Field key={k} label={k[0]?.toUpperCase() + k.slice(1)}>
                  {({ id }) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      {...s.form.register(`warmPool.${k}` as FieldPath<OrgSettings['sandbox']>, {
                        valueAsNumber: true,
                      })}
                    />
                  )}
                </Field>
              ))}
            </fieldset>
            <Field
              label="Idle timeout (minutes)"
              error={s.form.formState.errors.idleTimeoutMinutes?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...s.form.register('idleTimeoutMinutes', { valueAsNumber: true })}
                />
              )}
            </Field>
            <Button type="submit" disabled={s.patch.isPending}>
              Save sandboxes
            </Button>
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
    values: settings.data
      ? {
          logsRetentionDays: settings.data.logs.retentionDays,
          capturePreviews: settings.data.logs.capturePreviews,
          managerVisibility: settings.data.logs.managerVisibility,
          auditRetentionDays: settings.data.audit.retentionDays,
          webhookUrl: settings.data.audit.webhookUrl ?? '',
        }
      : undefined,
  });
  return (
    <QueryBoundary query={settings}>
      {() => (
        <Card aria-label="Retention" className="max-w-2xl gap-4">
          <CardHeader title="Retention and privacy" />
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit((v) =>
              patch
                .mutateAsync({
                  logs: {
                    retentionDays: v.logsRetentionDays,
                    capturePreviews: v.capturePreviews,
                    managerVisibility: v.managerVisibility,
                  },
                  audit: { retentionDays: v.auditRetentionDays, webhookUrl: v.webhookUrl || null },
                })
                .then(() => toast.success('Retention saved')),
            )}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Call log (days)"
                error={form.formState.errors.logsRetentionDays?.message}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    {...form.register('logsRetentionDays', { valueAsNumber: true })}
                  />
                )}
              </Field>
              <Field
                label="Audit log (days)"
                error={form.formState.errors.auditRetentionDays?.message}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    {...form.register('auditRetentionDays', { valueAsNumber: true })}
                  />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-3">
              <Switch
                checked={form.watch('capturePreviews')}
                onCheckedChange={(v) => form.setValue('capturePreviews', v, { shouldDirty: true })}
              />
              <span>
                <span className="block text-label">Keep redacted previews</span>
                <span className="block text-caption text-muted">
                  Stores 2 KiB of each call’s arguments and result.
                </span>
              </span>
            </label>
            <label className="flex items-center gap-3">
              <Switch
                checked={form.watch('managerVisibility')}
                onCheckedChange={(v) =>
                  form.setValue('managerVisibility', v, { shouldDirty: true })
                }
              />
              <span className="text-label">Managers see their team’s calls</span>
            </label>
            <Field
              label="Audit webhook (optional)"
              error={form.formState.errors.webhookUrl?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="https://siem.example.com/hook"
                  {...form.register('webhookUrl')}
                />
              )}
            </Field>
            <Button type="submit" disabled={patch.isPending}>
              Save retention
            </Button>
          </form>
        </Card>
      )}
    </QueryBoundary>
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
              <StatusDot
                tone={s.kms.healthy ? 'ok' : 'bad'}
                label={s.kms.healthy ? 'Reachable' : 'Unreachable'}
              />
              <span className="flex-1 text-label">{s.kms.provider}</span>
              <span className="text-caption text-muted">
                {s.kms.lastRotatedAt
                  ? `rotated ${formatDate(s.kms.lastRotatedAt)}`
                  : 'never rotated'}
              </span>
            </div>
            {s.kms.kekRef ? (
              <p className="m-0 break-all font-mono text-caption text-muted">{s.kms.kekRef}</p>
            ) : null}
            <p className="m-0 text-muted">
              Secrets are envelope-encrypted. Rotating re-wraps data keys; nothing is shown or lost.
            </p>
            <Button variant="outline" className="self-start" onClick={() => setConfirm(true)}>
              Rotate keys
            </Button>
            <Dialog open={confirm} onOpenChange={setConfirm}>
              <DialogContent
                title="Rotate encryption keys?"
                description="This re-wraps every data key with a new key version."
              >
                <div className="flex gap-2">
                  <Button
                    disabled={rotate.isPending}
                    onClick={() =>
                      rotate.mutate(undefined, {
                        onSuccess: (r) => {
                          toast.success(`Keys rotated: ${r.rewrapped} data keys re-wrapped`);
                          setConfirm(false);
                        },
                      })
                    }
                  >
                    Rotate
                  </Button>
                  <Button variant="outline" onClick={() => setConfirm(false)}>
                    Cancel
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </>
        )}
      </QueryBoundary>
    </Card>
  );
}

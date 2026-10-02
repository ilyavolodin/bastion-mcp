import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useDeleteInstallation, usePatchInstallation, useRestartInstallation } from '@/api/hooks';
import type { Body } from '@/api/schema';
import type { InstallationView } from '@/api/views/servers';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/** The constraints of `installationPatchSchema` (displayName 1 to 200, toolPrefix 1 to 40). */
const namesSchema = z.object({
  displayName: z.string().trim().min(1, 'Give the server a name').max(200, 'Keep it under 200'),
  toolPrefix: z.string().min(1, 'Enter a prefix').max(40, 'Up to 40 characters'),
});
type Names = z.infer<typeof namesSchema>;

export const toNamesPatch = (v: Names): Body<'patch', '/installations/{id}'> => ({
  displayName: v.displayName.trim(),
  toolPrefix: v.toolPrefix,
});

/** The variables an installation was set up with: values up to 4096 characters (`installationPatchSchema`). */
export const toVariablesPatch = (
  values: Record<string, string>,
): Body<'patch', '/installations/{id}'> => ({ variables: values });

function VariablesCard({ installation: i }: { installation: InstallationView }) {
  const patch = usePatchInstallation(i.id);
  const names = Object.keys(i.variables);
  const form = useForm<Record<string, string>>({ defaultValues: i.variables });
  if (names.length === 0) return null;
  return (
    <Card aria-label="Settings" className="gap-4">
      <CardHeader title="Settings" />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={form.handleSubmit((values) => {
          if (Object.values(values).some((v) => v.length > 4096)) {
            form.setError(names[0] ?? '', { message: 'Keep values under 4096 characters' });
            return;
          }
          patch.mutate(toVariablesPatch(values), { onSuccess: () => toast.success('Saved') });
        })}
      >
        {names.map((name) => (
          <Field key={name} label={name} error={form.formState.errors[name]?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register(name)}
              />
            )}
          </Field>
        ))}
        <Button type="submit" disabled={patch.isPending}>
          Save settings
        </Button>
      </form>
    </Card>
  );
}

/** Names, version pinning, enable or disable, remove (18.3). Sends If-Match via the ETag cache. */
export function SettingsTab({ installation: i }: { installation: InstallationView }) {
  const patch = usePatchInstallation(i.id);
  const del = useDeleteInstallation();
  const restart = useRestartInstallation(i.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = React.useState(false);
  const form = useForm<Names>({
    resolver: zodResolver(namesSchema),
    defaultValues: { displayName: i.displayName, toolPrefix: i.toolPrefix },
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card aria-label="Names" className="gap-4">
        <CardHeader title="Names" />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={form.handleSubmit((v) =>
            patch.mutate(toNamesPatch(v), { onSuccess: () => toast.success('Saved') }),
          )}
        >
          <Field label="Name" error={form.formState.errors.displayName?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('displayName')}
              />
            )}
          </Field>
          <Field
            label="URL name"
            help="Part of this server’s own URL. It cannot change after install."
          >
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={i.slug} readOnly disabled />
            )}
          </Field>
          <Field
            label="Tool prefix"
            help="Added to tool names on a combined endpoint"
            error={form.formState.errors.toolPrefix?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('toolPrefix')}
              />
            )}
          </Field>
          {patch.isError ? <ProblemAlert error={patch.error} /> : null}
          <Button type="submit" disabled={patch.isPending}>
            Save names
          </Button>
        </form>
      </Card>
      <Card aria-label="Behaviour" className="gap-4">
        <CardHeader title="Behaviour" />
        {i.catalogEntryId ? (
          <label className="flex items-center gap-3">
            <Switch
              checked={i.pinnedVersion}
              onCheckedChange={(v) => patch.mutate({ pinnedVersion: v })}
            />
            <span>
              <span className="block text-label">
                Stay on version {i.versionLabel ?? 'this version'}
              </span>
              <span className="block text-caption text-muted">
                Otherwise this follows new published versions.
              </span>
            </span>
          </label>
        ) : null}
        <label className="flex items-center gap-3">
          <Switch checked={i.enabled} onCheckedChange={(v) => patch.mutate({ enabled: v })} />
          <span className="text-label">{i.enabled ? 'Enabled' : 'Turned off'}</span>
        </label>
        {i.sandboxed ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={restart.isPending}
            onClick={() =>
              restart.mutate(undefined, { onSuccess: () => toast.success('Restart requested') })
            }
          >
            Restart server
          </Button>
        ) : null}
        <div className="border-t border-line pt-4">
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Remove server
          </Button>
        </div>
      </Card>
      <VariablesCard installation={i} />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent
          title={`Remove ${i.displayName}?`}
          description="Its tools leave every endpoint. Secrets and sign-in are deleted."
        >
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(i.id, {
                  onSuccess: () => {
                    toast.success(`${i.displayName} removed`);
                    void navigate({ to: '/servers' });
                  },
                })
              }
            >
              Remove
            </Button>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

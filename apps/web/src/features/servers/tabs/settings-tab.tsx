import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useDeleteInstallation, usePatchInstallation, useRestartInstallation } from '@/api/hooks';
import type { Installation } from '@/api/types';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const schema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lowercase letters, digits and hyphens'),
  toolPrefix: z.string().regex(/^[A-Za-z0-9_]{1,40}$/, 'Letters, digits and underscores, up to 40'),
});
type Values = z.infer<typeof schema>;

/** Slug, prefix, version pinning, enable or disable, remove (18.3). Sends If-Match via the ETag cache. */
export function SettingsTab({ installation: i }: { installation: Installation }) {
  const patch = usePatchInstallation(i.id);
  const del = useDeleteInstallation();
  const restart = useRestartInstallation(i.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = React.useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { slug: i.slug, toolPrefix: i.toolPrefix },
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card aria-label="Names" className="gap-4">
        <CardHeader title="Names" />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={form.handleSubmit((v) =>
            patch.mutate(v, { onSuccess: () => toast.success('Saved') }),
          )}
        >
          <Field
            label="Slug"
            help="Part of this server’s own URL"
            error={form.formState.errors.slug?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                disabled={!i.canManage}
                {...form.register('slug')}
              />
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
                disabled={!i.canManage}
                {...form.register('toolPrefix')}
              />
            )}
          </Field>
          <Button type="submit" disabled={!i.canManage || patch.isPending}>
            Save names
          </Button>
        </form>
      </Card>
      <Card aria-label="Behaviour" className="gap-4">
        <CardHeader title="Behaviour" />
        <label className="flex items-center gap-3">
          <Switch
            checked={i.pinnedVersion}
            disabled={!i.canManage}
            onCheckedChange={(v) => patch.mutate({ pinnedVersion: v })}
          />
          <span>
            <span className="block text-label">Stay on version {i.versionLabel}</span>
            <span className="block text-caption text-muted">
              Otherwise this follows new published versions.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-3">
          <Switch
            checked={i.enabled}
            disabled={!i.canManage}
            onCheckedChange={(v) => patch.mutate({ enabled: v })}
          />
          <span className="text-label">{i.enabled ? 'Enabled' : 'Turned off'}</span>
        </label>
        {i.runtime !== 'remote' ? (
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
          <Button variant="danger" disabled={!i.canManage} onClick={() => setConfirm(true)}>
            Remove server
          </Button>
        </div>
      </Card>
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

import { KeyRound } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useDisconnectInstallation, useSetSecret } from '@/api/hooks';
import type { Installation } from '@/api/types';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { StatusDot } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';
import { useInstallationAction } from '../use-installation-action';

function ReplaceSecret({
  installation,
  name,
  open,
  onOpenChange,
}: {
  installation: Installation;
  name: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const set = useSetSecret(installation.id);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setValue('');
          setError(undefined);
        }
      }}
    >
      <DialogContent
        title={`Replace ${name}`}
        description="The new value is encrypted and never shown again."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return setError('Enter a value');
            set.mutate(
              { name, value },
              {
                onSuccess: () => {
                  toast.success(`${name} saved`);
                  setValue('');
                  onOpenChange(false);
                },
              },
            );
          }}
        >
          <Field label="New value" error={error}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={set.isPending}>
            Save secret
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** OAuth status with scopes and expiry, secrets (set or not set, never values) and reconnect (18.3). */
export function ConnectionTab({ installation: i }: { installation: Installation }) {
  const { run, pending } = useInstallationAction();
  const disconnect = useDisconnectInstallation(i.id);
  const [replacing, setReplacing] = React.useState<string | null>(null);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {i.oauth ? (
        <Card aria-label="Sign-in" className="gap-3.5">
          <CardHeader title={`${i.oauth.provider} sign-in`} />
          <StatusDot
            tone={i.oauth.connected ? 'ok' : 'warn'}
            label={i.oauth.connected ? 'Connected' : 'Not connected'}
          />
          <dl className="m-0 grid grid-cols-[100px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted">Scopes</dt>
            <dd className="m-0 font-mono">{i.oauth.scopes.join(', ')}</dd>
            <dt className="text-muted">Expires</dt>
            <dd className="m-0">
              {i.oauth.expiresAt ? formatDate(i.oauth.expiresAt) : 'Not connected'}
            </dd>
          </dl>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run({ ...i, status: i.oauth?.connected ? 'reconnect_required' : 'needs_setup' })
              }
            >
              {i.oauth.connected ? 'Reconnect' : `Connect ${i.displayName}`}
            </Button>
            {i.oauth.connected && i.canManage ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  disconnect.mutate(undefined, { onSuccess: () => toast.success('Disconnected') })
                }
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}
      <Card aria-label="Secrets" className="gap-3.5">
        <CardHeader title="Secrets" />
        {i.secrets.length === 0 ? (
          <p className="m-0 text-muted">This server needs no secrets.</p>
        ) : (
          i.secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2.5 rounded-md bg-sunken px-3 py-2.5"
            >
              <KeyRound className="size-4 text-muted" aria-hidden="true" />
              <span className="flex-1 font-mono text-[13px] font-medium">{s.name}</span>
              <StatusDot tone={s.set ? 'ok' : 'warn'} label={s.set ? 'Set' : 'Not set'} />
              {i.canManage ? (
                <Button variant="outline" size="xs" onClick={() => setReplacing(s.name)}>
                  {s.set ? 'Replace secret' : 'Add secret'}
                </Button>
              ) : null}
            </div>
          ))
        )}
        <p className="m-0 text-caption text-muted">
          {i.ownerType === 'team' ? 'Shared team secret. ' : ''}Values are never shown.
        </p>
      </Card>
      {replacing ? (
        <ReplaceSecret
          installation={i}
          name={replacing}
          open
          onOpenChange={(o) => !o && setReplacing(null)}
        />
      ) : null}
    </div>
  );
}

import * as React from 'react';
import { toast } from 'sonner';
import { useOAuthClients, usePatchOAuthClient, useRegisterOAuthClient } from '@/api/hooks';
import { oauthName, oauthRegistration, oauthStatus } from '@/api/views/access';
import { EmptyState } from '@/components/empty-state';
import { Field, FormError, useFormErrors } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { fieldErrors } from '@/lib/form-errors';
import { oauthClientFormSchema, oauthClientToBody } from '../forms';

export function OAuthClientsTab() {
  const clients = useOAuthClients();
  const patch = usePatchOAuthClient();
  const register = useRegisterOAuthClient();
  const [open, setOpen] = React.useState(false);
  const [clientId, setClientId] = React.useState('');
  const [preApproved, setPreApproved] = React.useState(true);
  const form = useFormErrors();
  return (
    <Card aria-label="OAuth clients" className="gap-3">
      <CardHeader
        title="OAuth clients"
        subtitle="AI tools that ask to sign in to Bastion"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Register client
          </Button>
        }
      />
      <QueryBoundary
        query={clients}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No clients yet"
            description="Clients appear here the first time an AI tool connects."
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((c) => {
              const status = oauthStatus(c);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-label">{oauthName(c.clientId)}</div>
                    <div className="truncate font-mono text-caption text-muted">
                      {c.clientId} · {oauthRegistration(c.clientId)}
                    </div>
                  </div>
                  <Tag tone={status === 'approved' ? 'ok' : status === 'blocked' ? 'bad' : 'warn'}>
                    {status}
                  </Tag>
                  {status !== 'approved' ? (
                    <Button
                      size="xs"
                      onClick={() =>
                        patch.mutate({ id: c.id, patch: { preApproved: true, blocked: false } })
                      }
                    >
                      Approve
                    </Button>
                  ) : null}
                  {status !== 'blocked' ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => patch.mutate({ id: c.id, patch: { blocked: true } })}
                    >
                      Block
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Register an OAuth client"
          description="Decide about a client before it connects."
        >
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = oauthClientFormSchema.safeParse({
                clientId,
                preApproved,
                blocked: false,
              });
              if (!parsed.success) return form.set(fieldErrors(parsed.error));
              form.clear();
              register.mutate(oauthClientToBody(parsed.data), {
                onSuccess: () => {
                  setOpen(false);
                  setClientId('');
                  toast.success('Client registered');
                },
                onError: form.fromServer,
              });
            }}
          >
            <Field
              label="Client id"
              required
              help="The client's metadata document URL, or the id it registered with."
              error={form.errors.clientId}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-[14px]">
              <Checkbox
                checked={preApproved}
                onCheckedChange={(v) => setPreApproved(v === true)}
                aria-label="Approve this client now"
              />
              Approve this client now
            </label>
            <FormError message={form.errors.form} />
            <Button type="submit" disabled={register.isPending}>
              Register
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

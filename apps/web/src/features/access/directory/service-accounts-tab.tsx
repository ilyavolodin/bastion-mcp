import { KeyRound, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import {
  useCreateServiceAccount,
  useDeleteServiceAccount,
  useRotateServiceAccount,
  useServiceAccounts,
  useTeams,
} from '@/api/hooks';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Field, FormError, useFormErrors } from '@/components/form';
import { Card, CardHeader, Chip, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { fieldErrors } from '@/lib/form-errors';
import { SLUG_HELP, serviceAccountFormSchema, serviceAccountToBody, useSlug } from '../forms';

/** The client id and the one-time secret of a new or rotated service account credential. */
function CredentialDialog({
  credential,
  onClose,
}: {
  credential: { name: string; clientId: string; clientSecret?: string | undefined } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={credential !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Service account credentials"
        description={`Use these to sign ${credential?.name ?? 'the account'} in to Bastion.`}
      >
        {credential ? (
          <div className="flex flex-col gap-3">
            <CopyField label="Client id" value={credential.clientId} tone="sunken" mono />
            {credential.clientSecret ? (
              <>
                <CopyField
                  label="Client secret"
                  value={credential.clientSecret}
                  tone="sunken"
                  mono
                />
                <p className="m-0 text-caption text-muted">
                  Copy the secret now. Bastion stores only a hash and cannot show it again.
                </p>
              </>
            ) : (
              <p className="m-0 text-caption text-muted">
                This account signs in with its registered public keys; there is no secret.
              </p>
            )}
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ServiceAccountsTab() {
  const accounts = useServiceAccounts();
  const teams = useTeams();
  const create = useCreateServiceAccount();
  const rotate = useRotateServiceAccount();
  const del = useDeleteServiceAccount();
  const [open, setOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');
  const [teamId, setTeamId] = React.useState('');
  const [authMethod, setAuthMethod] = React.useState<'client_secret_basic' | 'private_key_jwt'>(
    'client_secret_basic',
  );
  const [jwks, setJwks] = React.useState('');
  const [credential, setCredential] = React.useState<{
    name: string;
    clientId: string;
    clientSecret?: string | undefined;
  } | null>(null);
  const url = useSlug(displayName);
  const form = useFormErrors();
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? id;
  return (
    <Card aria-label="Service accounts" className="gap-3">
      <CardHeader
        title="Service accounts"
        subtitle="Belong to one team; its managers administer them"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            New service account
          </Button>
        }
      />
      <QueryBoundary
        query={accounts}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No service accounts"
            description="Create one for a CI job or an agent that calls Bastion without a person."
            action={{ label: 'New service account', onClick: () => setOpen(true) }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <span className="flex-1 font-mono text-[13px] font-medium">{a.displayName}</span>
                <Chip>{teamName(a.teamId)}</Chip>
                <span className="font-mono text-caption text-muted max-md:hidden">
                  {a.oauthClientId ?? 'no client'}
                </span>
                <Tag tone="neutral">
                  {a.authMethod === 'private_key_jwt' ? 'Public key' : 'Secret'}
                </Tag>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rotate credentials of ${a.displayName}`}
                  onClick={() =>
                    rotate.mutate(a.id, {
                      onSuccess: (r) =>
                        setCredential({
                          name: a.displayName,
                          clientId: r.clientId,
                          clientSecret: r.clientSecret,
                        }),
                    })
                  }
                >
                  <KeyRound className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${a.displayName}`}
                  onClick={() => del.mutate(a.id)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New service account">
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = serviceAccountFormSchema.safeParse({
                displayName,
                slug: url.slug,
                teamId,
                authMethod,
                jwks,
              });
              if (!parsed.success) return form.set(fieldErrors(parsed.error));
              form.clear();
              create.mutate(serviceAccountToBody(parsed.data), {
                onSuccess: (r) => {
                  setOpen(false);
                  setDisplayName('');
                  setJwks('');
                  url.reset();
                  setCredential({
                    name: r.displayName,
                    clientId: r.clientId,
                    clientSecret: r.clientSecret,
                  });
                  toast.success('Service account created');
                },
                onError: form.fromServer,
              });
            }}
          >
            <Field label="Name" required error={form.errors.displayName}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              )}
            </Field>
            <Field label="URL name" required help={SLUG_HELP} error={form.errors.slug}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  className="font-mono"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={url.slug}
                  onChange={(e) => url.setSlug(e.target.value)}
                />
              )}
            </Field>
            <Field label="Team" required error={form.errors.teamId}>
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">Choose a team</option>
                  {(teams.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Sign in with">
              {({ id }) => (
                <Select
                  id={id}
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}
                >
                  <option value="client_secret_basic">A client secret</option>
                  <option value="private_key_jwt">A signed key (private key JWT)</option>
                </Select>
              )}
            </Field>
            {authMethod === 'private_key_jwt' ? (
              <Field
                label="Public keys"
                required
                help="A JWKS document or an array of public JWKs."
                error={form.errors.jwks}
              >
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    className="font-mono"
                    rows={5}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={jwks}
                    onChange={(e) => setJwks(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            <FormError message={form.errors.form} />
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />
    </Card>
  );
}

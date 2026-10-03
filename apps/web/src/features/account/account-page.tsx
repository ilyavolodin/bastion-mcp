import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useChangePassword, useOAuthGrants, useRevokeOAuthGrant } from '@/api/hooks/account';
import { useAuth } from '@/auth/auth';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';
import { roleLabel } from '@/lib/roles';
import { ConfirmDialog } from '../catalog/entry-actions';
import { applyServerErrors } from '../settings/form-errors';

/** The same rules the server enforces (9.1); the server stays the authority. */
export const MIN_PASSWORD_LENGTH = 8;

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
      .max(256, 'Use at most 256 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  });

type Values = z.infer<typeof schema>;

/** Change password: for accounts that sign in with a local password (the break-glass administrators). */
export function ChangePasswordCard() {
  const change = useChangePassword();
  const [formError, setFormError] = React.useState<string>();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const { errors } = form.formState;
  const submit = form.handleSubmit(async (v) => {
    setFormError(undefined);
    try {
      await change.mutateAsync({ currentPassword: v.currentPassword, newPassword: v.newPassword });
      form.reset();
      toast.success('Password changed. Your other sessions were signed out.');
    } catch (error) {
      setFormError(applyServerErrors(form, error));
    }
  });
  return (
    <Card aria-label="Change password" className="gap-4">
      <CardHeader title="Change password" />
      <p className="m-0 text-muted">
        For accounts that sign in with a password. If you sign in through your organization’s single
        sign-on, change the password there.
      </p>
      <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Current password" required error={errors.currentPassword?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('currentPassword')}
            />
          )}
        </Field>
        <Field
          label="New password"
          required
          help={`At least ${MIN_PASSWORD_LENGTH} characters. A passphrase of several words works well.`}
          error={errors.newPassword?.message}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('newPassword')}
            />
          )}
        </Field>
        <Field label="Repeat the new password" required error={errors.confirm?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...form.register('confirm')}
            />
          )}
        </Field>
        {formError ? (
          <p role="alert" className="m-0 font-medium text-coral-ink">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={change.isPending} className="self-start">
          Change password
        </Button>
      </form>
    </Card>
  );
}

const SCOPE_WORDS: Record<string, string> = {
  mcp: 'Use your MCP servers',
  'api:read': 'Read your Bastion data',
  'api:write': 'Change your Bastion data',
  'plugins:read': 'Download your plugins',
  offline_access: 'Stay signed in',
};

/**
 * Connected apps (9.4): the AI tools that were let in as the signed-in person. Revoking one takes away its refresh
 * tokens, so when its short access token ends it signs in again and is asked which account it is for.
 */
export function ConnectedAppsCard() {
  const grants = useOAuthGrants();
  const revoke = useRevokeOAuthGrant();
  const [target, setTarget] = React.useState<{ id: string; clientId: string } | null>(null);
  return (
    <Card aria-label="Connected apps" className="gap-3 lg:col-span-2">
      <CardHeader title="Connected apps" subtitle="AI tools that can act as you" />
      <QueryBoundary
        query={grants}
        label="Loading connected apps"
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            title="No connected apps"
            description="An AI tool you sign in to Bastion from appears here, and you can cut it off."
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((g) => (
              <li
                key={g.id}
                className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px]">{g.clientId}</div>
                  <div className="text-caption text-muted">
                    {g.scopes.map((s) => SCOPE_WORDS[s] ?? s).join(', ') || 'Sign-in only'} ·
                    authorized {formatDate(g.createdAt)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Revoke ${g.clientId}`}
                  onClick={() => setTarget({ id: g.id, clientId: g.clientId })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title="Revoke this app?"
        description={`${target?.clientId ?? 'The app'} will lose access as you. It has to sign in again, and you choose the account then.`}
        confirmLabel="Revoke access"
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => {
          if (!target) return;
          revoke.mutate(target.id, {
            onSuccess: () => {
              toast.success('Access revoked');
              setTarget(null);
            },
          });
        }}
      />
    </Card>
  );
}

export function AccountPage() {
  const { me, role } = useAuth();
  return (
    <>
      <PageHeader title="Account" subtitle="Your sign-in and profile." />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card aria-label="Profile" className="gap-3">
          <CardHeader title="Profile" />
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-muted">Name</dt>
            <dd className="m-0 truncate">{me.name}</dd>
            <dt className="text-muted">Email</dt>
            <dd className="m-0 truncate">{me.email}</dd>
            <dt className="text-muted">Role</dt>
            <dd className="m-0">{roleLabel(role, me)}</dd>
          </dl>
        </Card>
        <ChangePasswordCard />
        <ConnectedAppsCard />
      </div>
    </>
  );
}

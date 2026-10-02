import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useChangePassword } from '@/api/hooks/account';
import { useAuth } from '@/auth/auth';
import { Field } from '@/components/form';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { roleLabel } from '@/lib/roles';
import { applyServerErrors } from '../settings/form-errors';

/** The same rules the server enforces (9.1); the server stays the authority. */
export const MIN_PASSWORD_LENGTH = 12;

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
      </div>
    </>
  );
}

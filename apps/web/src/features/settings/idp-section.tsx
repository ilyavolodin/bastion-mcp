import { zodResolver } from '@hookform/resolvers/zod';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { useCreateIdp, useIdpConnections, useTestIdp, useUpdateIdp } from '@/api/hooks';
import {
  discoveryUrlFor,
  emptyIdpForm,
  type IdpConnection,
  type IdpFormValues,
  type IdpTestResult,
  idpCreateBody,
  idpPatchBody,
  idpRedirectUri,
  idpTestSteps,
  idpToForm,
} from '@/api/views/settings';
import { useAuth } from '@/auth/auth';
import { CopyField } from '@/components/copy-field';
import { EmptyState } from '@/components/empty-state';
import { Field } from '@/components/form';
import { Card, CardHeader, Tag } from '@/components/primitives';
import { QueryBoundary } from '@/components/query-boundary';
import { StatusDot } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { applyServerErrors } from './form-errors';

/** Mirrors `idpCreateSchema` / `idpPatchSchema` of the API (packages/api/src/schemas/identity.ts). */
const idpSchema = (creating: boolean) =>
  z.object({
    name: z.string().trim().min(1, 'Name the connection').max(100, 'At most 100 characters'),
    issuer: z.string().trim().url('Enter a full URL').max(2048, 'At most 2048 characters'),
    discoveryUrl: z.string().trim().url('Enter a full URL').max(2048, 'At most 2048 characters'),
    clientId: z.string().trim().min(1, 'Required').max(512, 'At most 512 characters'),
    clientSecret: creating
      ? z.string().min(1, 'Required').max(4096, 'At most 4096 characters')
      : z.string().max(4096, 'At most 4096 characters'),
    scopes: z
      .string()
      .refine((v) => v.split(/\s+/).filter(Boolean).length > 0, 'Give at least one scope'),
    claimEmail: z.string(),
    claimName: z.string(),
    claimGroups: z.string(),
    claimSub: z.string(),
    emailDomains: z.string(),
    apiScope: z.string(),
    storeRefreshToken: z.boolean(),
    enterpriseManagedAuth: z.boolean(),
    redirectToRoot: z.boolean(),
    enabled: z.boolean(),
  });

function TestResult({ result }: { result: IdpTestResult }) {
  return (
    <ul
      aria-label="Connection test"
      className="m-0 flex list-none flex-col gap-1.5 rounded-md bg-sunken p-3 text-[13px]"
    >
      {idpTestSteps(result).map((s) => (
        <li key={s.name} className="flex items-center gap-2">
          <StatusDot tone={s.ok ? 'ok' : 'bad'} label={s.ok ? 'Passed' : 'Failed'} hideLabel />
          <span className="font-medium">{s.name}</span>
          <span className="break-all text-muted">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function IdpDialog({ editing, onClose }: { editing: IdpConnection | 'new'; onClose: () => void }) {
  const creating = editing === 'new';
  const create = useCreateIdp();
  const update = useUpdateIdp();
  const [formError, setFormError] = React.useState<string | undefined>();
  const [discoveryTouched, setDiscoveryTouched] = React.useState(!creating);
  const form = useForm<IdpFormValues>({
    resolver: zodResolver(idpSchema(creating)),
    defaultValues: creating ? emptyIdpForm() : idpToForm(editing),
  });
  const { errors } = form.formState;
  const issuerField = form.register('issuer');
  const discoveryField = form.register('discoveryUrl');
  const pending = create.isPending || update.isPending;
  const submit = form.handleSubmit((v) => {
    setFormError(undefined);
    const done = {
      onSuccess: () => {
        toast.success('Connection saved');
        onClose();
      },
      onError: (e: Error) => setFormError(applyServerErrors(form, e)),
    };
    if (editing === 'new') create.mutate(idpCreateBody(v), done);
    else update.mutate({ id: editing.id, body: idpPatchBody(v) }, done);
  });
  const text = (
    name: keyof IdpFormValues,
    label: string,
    extra: { help?: string; required?: boolean; placeholder?: string; type?: string } = {},
  ) => (
    <Field label={label} help={extra.help} required={extra.required} error={errors[name]?.message}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type={extra.type}
          autoComplete={extra.type === 'password' ? 'new-password' : 'off'}
          placeholder={extra.placeholder}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...form.register(name as never)}
        />
      )}
    </Field>
  );
  const flag = (
    name: 'storeRefreshToken' | 'enterpriseManagedAuth' | 'redirectToRoot' | 'enabled',
    label: string,
    help: string,
  ) => (
    <label className="flex items-center gap-3">
      <Switch
        checked={form.watch(name)}
        onCheckedChange={(v) => form.setValue(name, v, { shouldDirty: true })}
        aria-label={label}
      />
      <span>
        <span className="block text-label">{label}</span>
        <span className="block text-caption text-muted">{help}</span>
      </span>
    </label>
  );
  return (
    <form noValidate className="flex flex-col gap-3.5" onSubmit={submit}>
      {text('name', 'Name', { required: true })}
      <Field label="Issuer" required help="The OIDC issuer URL" error={errors.issuer?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            placeholder="https://acme.okta.com"
            {...issuerField}
            onChange={(e) => {
              void issuerField.onChange(e);
              if (!discoveryTouched && e.target.value.trim())
                form.setValue('discoveryUrl', discoveryUrlFor(e.target.value), {
                  shouldDirty: true,
                });
            }}
          />
        )}
      </Field>
      <Field
        label="Discovery URL"
        required
        help="Follows the issuer until you edit it"
        error={errors.discoveryUrl?.message}
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...discoveryField}
            onChange={(e) => {
              setDiscoveryTouched(true);
              void discoveryField.onChange(e);
            }}
          />
        )}
      </Field>
      <div className="grid gap-3.5 sm:grid-cols-2">
        {text('clientId', 'Client ID', { required: true })}
        {text('clientSecret', 'Client secret', {
          type: 'password',
          required: creating,
          help: creating
            ? 'Stored encrypted, never shown again'
            : 'Leave empty to keep the current one',
        })}
      </div>
      {text('scopes', 'Scopes', { help: 'Separated by spaces' })}
      <fieldset className="m-0 grid gap-3.5 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-1.5 text-[13px] font-medium">Claim names in the ID token</legend>
        {text('claimEmail', 'Email claim', { placeholder: 'email' })}
        {text('claimName', 'Name claim', { placeholder: 'name' })}
        {text('claimGroups', 'Groups claim', { placeholder: 'groups' })}
        {text('claimSub', 'Subject claim', { placeholder: 'sub' })}
      </fieldset>
      {text('emailDomains', 'Allowed email domains', { help: 'Comma separated' })}
      {text('apiScope', 'API scope (optional)', {
        help: 'Requested when a token for the API is needed',
      })}
      {flag('enabled', 'Enabled', 'People can sign in with this provider')}
      {flag('storeRefreshToken', 'Keep refresh tokens', 'Stored encrypted to refresh the session')}
      {flag(
        'enterpriseManagedAuth',
        'Enterprise-managed authorization',
        'Use this IdP to authorize upstream servers',
      )}
      {flag(
        'redirectToRoot',
        'Redirect to the site address only',
        'For an IdP that accepts nothing but the site address as redirect URI, such as Synology SSO Server',
      )}
      {creating ? (
        <p className="m-0 text-caption text-muted">
          After you save, the redirect URI to register in your identity provider appears on the
          connection.
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="m-0 text-caption font-medium text-coral-ink">
          {formError}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        Save connection
      </Button>
    </form>
  );
}

export function IdpSection() {
  const q = useIdpConnections();
  const test = useTestIdp();
  const [results, setResults] = React.useState<Record<string, IdpTestResult>>({});
  const [editing, setEditing] = React.useState<IdpConnection | 'new' | null>(null);
  const { me } = useAuth();
  return (
    <Card aria-label="Identity providers" className="gap-3">
      <CardHeader
        title="Identity providers"
        subtitle="OIDC connections for sign-in"
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            Add connection
          </Button>
        }
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            title="No identity provider"
            description="Add an OIDC connection so people can sign in with your IdP."
            action={{ label: 'Add connection', onClick: () => setEditing('new') }}
          />
        }
      >
        {(items) => (
          <ul className="m-0 list-none p-0">
            {items.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-label">{c.name}</div>
                    <div className="truncate font-mono text-caption text-muted">{c.issuer}</div>
                  </div>
                  <Tag tone={c.enabled ? 'ok' : 'neutral'}>
                    {c.enabled ? 'Enabled' : 'Disabled'}
                  </Tag>
                  {c.emailDomains.length > 0 ? (
                    <span className="text-caption text-muted">{c.emailDomains.join(', ')}</span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate(c.id, {
                        onSuccess: (r) => setResults((x) => ({ ...x, [c.id]: r })),
                      })
                    }
                  >
                    Test connection
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-muted">
                    Redirect URI: register exactly this in your identity provider
                  </span>
                  <CopyField
                    tone="sunken"
                    mono
                    label={`Redirect URI of ${c.name}`}
                    value={idpRedirectUri(me.org.baseUrl, c)}
                  />
                </div>
                {results[c.id] ? <TestResult result={results[c.id] as IdpTestResult} /> : null}
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          title={editing === 'new' ? 'Add identity provider' : 'Edit identity provider'}
        >
          {editing ? (
            <IdpDialog
              key={editing === 'new' ? 'new' : editing.id}
              editing={editing}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

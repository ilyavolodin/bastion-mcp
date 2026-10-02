import { Link } from '@tanstack/react-router';
import { CheckCircle2, KeyRound, Link2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/client';
import { useConnectInstallation, useCreateInstallation, useTeamOptions } from '@/api/hooks';
import type { Schemas } from '@/api/schema';
import {
  defaultEndpointUrl,
  type InstallValues,
  installationUrl,
  needsOauth,
  type StoreEntryDetailView,
  toInstallBody,
} from '@/api/views/servers';
import { useAuth } from '@/auth/auth';
import { ClientConfigTabs } from '@/components/client-config';
import { CopyField } from '@/components/copy-field';
import { Field, FieldsInputs, useFieldsForm } from '@/components/form';
import { ServerIcon } from '@/components/primitives';
import { ProblemAlert } from '@/components/problem';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { useSlug } from '@/features/access/forms';
import { openAuthorization } from '../servers/use-installation-action';

type Step = 'setup' | 'connect' | 'ready';

/** `installationCreateSchema`: a slug of 2 to 40 characters. */
const SLUG = /^[a-z0-9-]{2,40}$/;

/** A secret goes to the installation after it exists (`PUT /installations/{id}/secrets/{name}`, 11.4). */
const putSecret = (id: string, name: string, value: string) =>
  api.put(`/installations/${id}/secrets/${encodeURIComponent(name)}`, { value }, { etag: '*' });

/** Teams the caller may install for: managers of their teams; admins pick any team (`installations.team`). */
const useInstallTargets = () => {
  const { me, role } = useAuth();
  const teams = useTeamOptions();
  const all = role === 'admin' ? (teams.data ?? []) : [];
  const own = me.teams.filter((t) => t.role === 'manager').map((t) => ({ id: t.id, name: t.name }));
  const merged = new Map([...own, ...all].map((t) => [t.id, t.name]));
  return [...merged].map(([id, name]) => ({ id, name }));
};

/**
 * Install flow (11.4): Install, a form for required variables and secrets, a Connect step for OAuth,
 * then a Ready screen with the endpoint URL and copyable client configuration.
 */
export function InstallFlow({
  entry,
  open,
  onOpenChange,
}: {
  entry: StoreEntryDetailView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { me } = useAuth();
  const [step, setStep] = React.useState<Step>('setup');
  const [installation, setInstallation] = React.useState<Schemas['Installation'] | null>(null);
  const create = useCreateInstallation();
  const connect = useConnectInstallation();
  const targets = useInstallTargets();
  const fields = React.useMemo(() => [...entry.variables, ...entry.secrets], [entry]);
  const form = useFieldsForm(fields);
  const slug = useSlug(entry.slug);
  const [owner, setOwner] = React.useState('user');
  const [pinned, setPinned] = React.useState(false);
  const [slugError, setSlugError] = React.useState<string | undefined>();
  const [error, setError] = React.useState<unknown>(null);
  const oauth = needsOauth(entry.spec);
  const installSlug = slug.slug;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog resets only when it opens
  React.useEffect(() => {
    if (open) {
      setStep('setup');
      setInstallation(null);
      setError(null);
      setSlugError(undefined);
      setOwner('user');
      setPinned(false);
      slug.reset();
      form.reset();
    }
  }, [open]);

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    if (!SLUG.test(installSlug)) {
      setSlugError('Use 2 to 40 lowercase letters, digits and dashes');
      return;
    }
    setSlugError(undefined);
    const input: InstallValues = {
      owner,
      slug: installSlug,
      pinnedVersion: pinned,
      fields: values,
    };
    try {
      const inst = await create.mutateAsync(toInstallBody(entry, input));
      setInstallation(inst);
      for (const s of entry.secrets) {
        const value = values[s.name];
        if (value) await putSecret(inst.id, s.name, value);
      }
      setStep(oauth ? 'connect' : 'ready');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 422 || e.status === 400)) {
        for (const fe of e.errors) {
          const name = fe.path.replace(/^\/?variables[./]/, '').replace(/^\//, '');
          if (name === 'slug') setSlugError(fe.message);
          else if (name in form.getValues()) form.setError(name, { message: fe.message });
        }
      }
      setError(e);
    }
  });

  const doConnect = () => {
    if (!installation) return;
    connect.mutate(
      { id: installation.id, returnTo: `/servers/${installation.id}?tab=connection` },
      {
        onSuccess: (res) => {
          openAuthorization(res.authorizationUrl);
          toast.success(`Connected to ${entry.displayName}`);
          setStep('ready');
        },
      },
    );
  };

  const titles: Record<Step, string> = {
    setup: `Install ${entry.displayName}`,
    connect: `Connect ${entry.displayName}`,
    ready: `${entry.displayName} is ready`,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={titles[step]}
        description={
          step === 'setup'
            ? 'Fill in what this server needs. You can change it later.'
            : step === 'connect'
              ? `Sign in to ${entry.displayName} so Bastion can act for you.`
              : 'Add Bastion to your AI tool once; new servers appear automatically.'
        }
        className="sm:max-w-xl"
      >
        <div className="flex items-center gap-3">
          <ServerIcon letter={entry.letter} color={entry.color} size={40} />
          <ol
            className="m-0 flex list-none gap-2 p-0 text-caption text-muted"
            aria-label="Install steps"
          >
            {(['setup', ...(oauth ? ['connect'] : []), 'ready'] as Step[]).map((s, i) => (
              <li
                key={s}
                aria-current={s === step ? 'step' : undefined}
                className={s === step ? 'font-semibold text-ink' : ''}
              >
                {i + 1}. {s === 'setup' ? 'Setup' : s === 'connect' ? 'Connect' : 'Ready'}
              </li>
            ))}
          </ol>
        </div>

        {step === 'setup' ? (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {fields.length === 0 ? (
              <p className="m-0 text-muted">
                Nothing to fill in.{' '}
                {oauth
                  ? `You will sign in to ${entry.displayName} next.`
                  : 'It is ready to use as soon as it is installed.'}
              </p>
            ) : (
              <FieldsInputs fields={fields} form={form} />
            )}
            {targets.length > 0 ? (
              <Field label="Install for">
                {({ id }) => (
                  <Select id={id} value={owner} onChange={(e) => setOwner(e.target.value)}>
                    <option value="user">Me</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        Team · {t.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field
              label="URL name"
              help={`Its own address is ${installationUrl(me.org.baseUrl, installSlug || '…')}`}
              error={slugError}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={installSlug}
                  onChange={(e) => slug.setSlug(e.target.value)}
                />
              )}
            </Field>
            <label className="flex items-center gap-2.5 text-[13px]">
              <Checkbox checked={pinned} onCheckedChange={(c) => setPinned(c === true)} />
              Stay on version {entry.version?.label ?? 'this version'} instead of following updates
            </label>
            {error ? <ProblemAlert error={error} /> : null}
            <Button
              type="submit"
              size="lg"
              disabled={create.isPending || form.formState.isSubmitting}
            >
              {create.isPending ? 'Installing…' : 'Install'}
            </Button>
          </form>
        ) : null}

        {step === 'connect' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-md bg-tangerine-soft p-4 text-tangerine-ink">
              <Link2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="m-0 text-ink">
                {entry.displayName} acts on your behalf, so it needs your sign-in. Bastion stores
                the token encrypted and never shows it to your AI tool.
              </p>
            </div>
            <Button size="lg" onClick={doConnect} disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : `Connect with ${entry.displayName}`}
            </Button>
            <Button variant="ghost" onClick={() => setStep('ready')}>
              Do this later
            </Button>
            {connect.isError ? <ProblemAlert error={connect.error} /> : null}
          </div>
        ) : null}

        {step === 'ready' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-mint-ink">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              <span className="text-label">
                {entry.displayName} is on your endpoint
                {oauth && connect.isIdle ? '. It asks you to sign in on first use.' : '.'}
              </span>
            </div>
            <CopyField
              value={defaultEndpointUrl(me.org.baseUrl)}
              label="endpoint URL"
              tone="sunken"
            />
            <ClientConfigTabs />
            <div className="flex gap-2">
              {installation ? (
                <Button asChild variant="outline">
                  <Link to={`/servers/${installation.id}`} onClick={() => onOpenChange(false)}>
                    Open {entry.displayName}
                  </Link>
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        ) : null}
        {step === 'setup' && entry.secrets.length > 0 ? (
          <p className="m-0 flex items-center gap-2 text-caption text-muted">
            <KeyRound className="size-3.5" aria-hidden="true" />
            Secrets are encrypted at rest and never shown again.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

import { Link } from '@tanstack/react-router';
import { CheckCircle2, KeyRound, Link2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { useConnectInstallation, useCreateInstallation, useEndpoints } from '@/api/hooks';
import type { Installation, StoreEntryDetail } from '@/api/types';
import { api, ApiError } from '@/api/client';
import { ClientConfigTabs } from '@/components/client-config';
import { CopyField } from '@/components/copy-field';
import { FieldsInputs, useFieldsForm } from '@/components/form';
import { ProblemAlert } from '@/components/problem';
import { ServerIcon } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

type Step = 'setup' | 'connect' | 'ready';

const putSecret = (id: string, name: string, value: string) =>
  api.put<void>(`/installations/${id}/secrets/${encodeURIComponent(name)}`, { value });

/**
 * Install flow (11.4): Install, a form for required variables and secrets, a Connect step for OAuth,
 * then a Ready screen with the endpoint URL and copyable client configuration.
 */
export function InstallFlow({
  entry,
  open,
  onOpenChange,
}: {
  entry: StoreEntryDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = React.useState<Step>('setup');
  const [installation, setInstallation] = React.useState<Installation | null>(null);
  const create = useCreateInstallation();
  const connect = useConnectInstallation();
  const endpoints = useEndpoints();
  const fields = React.useMemo(() => [...entry.form.variables, ...entry.form.secrets], [entry.form]);
  const form = useFieldsForm(fields);
  const [error, setError] = React.useState<unknown>(null);
  const needsOauth = Boolean(entry.setup.oauthProvider);

  React.useEffect(() => {
    if (open) {
      setStep('setup');
      setInstallation(null);
      setError(null);
      form.reset();
    }
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const variables = Object.fromEntries(
        entry.form.variables.map((v) => [v.name, values[v.name] ?? '']),
      );
      const inst = await create.mutateAsync({ entrySlug: entry.slug, variables });
      setInstallation(inst);
      for (const s of entry.form.secrets) {
        const value = values[s.name];
        if (value) {
          await putSecret(inst.id, s.name, value);
        }
      }
      setStep(needsOauth ? 'connect' : 'ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        for (const fe of e.errors) {
          const name = fe.path.replace(/^variables\./, '');
          if (name in form.getValues()) form.setError(name, { message: fe.message });
        }
      }
      setError(e);
    }
  });

  const doConnect = () => {
    if (!installation) return;
    connect.mutate(installation.id, {
      onSuccess: (res) => {
        if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
        toast.success(`Connected to ${entry.displayName}`);
        setStep('ready');
      },
    });
  };

  const endpoint = endpoints.data?.find((e) => e.isDefault) ?? endpoints.data?.[0];
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
              ? `Sign in to ${entry.setup.oauthProvider ?? entry.displayName} so Bastion can act for you.`
              : 'Add Bastion to your AI tool once; new servers appear automatically.'
        }
        className="sm:max-w-xl"
      >
        <div className="flex items-center gap-3">
          <ServerIcon letter={entry.letter} color={entry.color} size={40} />
          <ol className="m-0 flex list-none gap-2 p-0 text-caption text-muted" aria-label="Install steps">
            {(['setup', ...(needsOauth ? ['connect'] : []), 'ready'] as Step[]).map((s, i) => (
              <li key={s} aria-current={s === step ? 'step' : undefined} className={s === step ? 'font-semibold text-ink' : ''}>
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
                {needsOauth
                  ? `You will sign in to ${entry.setup.oauthProvider} next.`
                  : 'It is ready to use as soon as it is installed.'}
              </p>
            ) : (
              <FieldsInputs fields={fields} form={form} />
            )}
            {error ? <ProblemAlert error={error} /> : null}
            <Button type="submit" size="lg" disabled={create.isPending || form.formState.isSubmitting}>
              {create.isPending ? 'Installing…' : 'Install'}
            </Button>
          </form>
        ) : null}

        {step === 'connect' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-md bg-tangerine-soft p-4 text-tangerine-ink">
              <Link2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="m-0 text-ink">
                {entry.displayName} acts on your behalf, so it needs your {entry.setup.oauthProvider}. Bastion
                stores the token encrypted and never shows it to your AI tool.
              </p>
            </div>
            <Button size="lg" onClick={doConnect} disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : `Connect with ${entry.setup.oauthProvider}`}
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
                {needsOauth && connect.isIdle ? '. It asks you to sign in on first use.' : '.'}
              </span>
            </div>
            {endpoint ? <CopyField value={endpoint.url} label="endpoint URL" tone="sunken" /> : null}
            <ClientConfigTabs endpointId={endpoint?.id} />
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
        {step === 'setup' && entry.form.secrets.length > 0 ? (
          <p className="m-0 flex items-center gap-2 text-caption text-muted">
            <KeyRound className="size-3.5" aria-hidden="true" />
            Secrets are encrypted at rest and never shown again.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}


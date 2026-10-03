import { KeyRound, Plus } from 'lucide-react';
import * as React from 'react';
import { useOrgSecretNames } from '@/api/hooks';
import { useAuth } from '@/auth/auth';
import { Field } from '@/components/form';
import { Chip } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import {
  addHeaderPreset,
  addSecretArg,
  addSecretEnv,
  type HeaderPreset,
  needsClientSecret,
  type OAuthClientDraft,
  oauthClientSecretName,
  secretNamesOf,
} from '../draft';
import { type EditorProps, setSpec } from './props';
import { ArgRow, BindingRow, ReferenceList, RowCell } from './rows';

/**
 * Shared secrets: the author types each value once (written through the secrets API, encrypted, never shown again;
 * the editor only knows "set"). Personal secrets: the author names the field each installer fills in.
 */
export function SecretsSection({ draft, onChange, readOnly }: EditorProps) {
  const spec = draft.spec;
  const { role } = useAuth();
  const names = secretNamesOf(spec);
  const shared = spec.authMode === 'orgSecret';
  const existing = useOrgSecretNames(shared);
  if (names.length === 0) return null;
  return (
    <section aria-label="Secrets" className="flex flex-col gap-3 rounded-md bg-sunken p-3.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden="true" />
        <h3 className="m-0 text-label">{shared ? 'Shared secrets' : 'Personal secrets'}</h3>
      </div>
      <p className="m-0 text-caption text-muted">
        {shared
          ? 'Stored encrypted when you save the draft. The value is never shown again; type a new one to replace it.'
          : 'Each person enters their own value when they install. The label tells them what to enter.'}
      </p>
      {shared && role !== 'admin' ? (
        <p role="note" className="m-0 text-caption font-medium text-coral-ink">
          Only an Admin can set shared secrets. Ask an Admin to enter the value, or use a personal
          secret.
        </p>
      ) : null}
      {names.map((name) => {
        const isSet = existing.data?.has(name) ?? false;
        const typed = Boolean(spec.secretValues[name]);
        return (
          <div
            key={name}
            className="grid items-end gap-x-3 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[13px] font-medium leading-5">Secret</span>
              <code className="flex h-11 items-center truncate font-mono text-[13px]">{name}</code>
            </div>
            {shared ? (
              <RowCell label={`Value of ${name}`}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    disabled={readOnly}
                    placeholder={isSet ? 'Set. Type to replace' : 'Paste the token'}
                    value={spec.secretValues[name] ?? ''}
                    onChange={(e) =>
                      onChange(
                        setSpec(draft, {
                          secretValues: { ...spec.secretValues, [name]: e.target.value },
                        }),
                      )
                    }
                  />
                )}
              </RowCell>
            ) : (
              <RowCell label={`Label for ${name}`}>
                {(id) => (
                  <Input
                    id={id}
                    disabled={readOnly}
                    placeholder={name}
                    value={spec.secretLabels[name] ?? ''}
                    onChange={(e) =>
                      onChange(
                        setSpec(draft, {
                          secretLabels: { ...spec.secretLabels, [name]: e.target.value },
                        }),
                      )
                    }
                  />
                )}
              </RowCell>
            )}
            {shared ? (
              <div className="flex h-11 items-center">
                <Chip tone={isSet || typed ? 'ok' : 'warn'}>
                  {typed ? 'Will be saved' : isSet ? 'Set' : 'Not set'}
                </Chip>
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

const PRESETS: { id: HeaderPreset; label: string; help: string }[] = [
  { id: 'bearer', label: 'Bearer token', help: 'Authorization: Bearer <token>' },
  { id: 'apiKey', label: 'API key header', help: 'X-API-Key: <key>' },
  { id: 'custom', label: 'Custom header', help: 'Any name and value' },
];

/** Headers of a remote server, with presets for the common credentials (9.5). */
export function HeadersEditor({ draft, onChange, readOnly }: EditorProps) {
  const spec = draft.spec;
  const listId = React.useId();
  const add = (kind: HeaderPreset) => onChange({ ...draft, spec: addHeaderPreset(spec, kind) });
  return (
    <section aria-label="Headers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="m-0 min-w-0 flex-1 text-label">Headers</h3>
        <div role="group" aria-label="Add header" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="outline"
              size="sm"
              title={p.help}
              disabled={readOnly}
              onClick={() => add(p.id)}
            >
              <Plus className="size-4" aria-hidden="true" />
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="m-0 text-caption text-muted">
        Sent with every request to the server. A secret header value comes from the secret mode
        above: write it as {'{{secret.NAME}}'}, for example Bearer {'{{secret.TOKEN}}'}.
      </p>
      <ReferenceList id={listId} spec={spec} />
      {spec.headers.length === 0 ? <p className="m-0 text-muted">No extra headers.</p> : null}
      {spec.headers.map((row, i) => (
        <BindingRow
          key={i}
          kind="header"
          index={i}
          row={row}
          spec={spec}
          mode={spec.authMode}
          readOnly={readOnly}
          listId={listId}
          onChange={(next) =>
            onChange(setSpec(draft, { headers: spec.headers.map((r, k) => (k === i ? next : r)) }))
          }
          onRemove={() =>
            onChange(setSpec(draft, { headers: spec.headers.filter((_, k) => k !== i) }))
          }
        />
      ))}
    </section>
  );
}

/** Packages: the secret environment variables and arguments, where Configuration also lists them. */
export function PackageSecrets({ draft, onChange, readOnly }: EditorProps) {
  const spec = draft.spec;
  const listId = React.useId();
  const mode = spec.authMode;
  const addEnv = () => onChange({ ...draft, spec: addSecretEnv(spec) });
  const addArg = () => onChange({ ...draft, spec: addSecretArg(spec) });
  return (
    <section aria-label="Secret bindings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="m-0 min-w-0 flex-1 text-label">
          {mode === 'oauth' ? 'Where the access token goes' : 'Where the secret goes'}
        </h3>
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={addEnv}>
          <Plus className="size-4" aria-hidden="true" />
          Add secret environment variable
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={addArg}>
          <Plus className="size-4" aria-hidden="true" />
          Add secret argument
        </Button>
      </div>
      <p className="m-0 text-caption text-muted">
        The secret reaches the server as an environment variable or an argument. Plain ones are in
        Configuration.
      </p>
      <ReferenceList id={listId} spec={spec} />
      {spec.envVars.map((row, i) =>
        row.secret ? (
          <BindingRow
            key={`e${i}`}
            kind="env"
            index={i}
            row={row}
            spec={spec}
            mode={mode}
            readOnly={readOnly}
            listId={listId}
            onChange={(next) =>
              onChange(
                setSpec(draft, { envVars: spec.envVars.map((r, k) => (k === i ? next : r)) }),
              )
            }
            onRemove={() =>
              onChange(setSpec(draft, { envVars: spec.envVars.filter((_, k) => k !== i) }))
            }
          />
        ) : null,
      )}
      {spec.args.map((row, i) =>
        row.secret ? (
          <ArgRow
            key={`a${i}`}
            index={i}
            row={row}
            spec={spec}
            mode={mode}
            readOnly={readOnly}
            listId={listId}
            onChange={(next) =>
              onChange(setSpec(draft, { args: spec.args.map((r, k) => (k === i ? next : r)) }))
            }
            onRemove={() => onChange(setSpec(draft, { args: spec.args.filter((_, k) => k !== i) }))}
          />
        ) : null,
      )}
    </section>
  );
}

/**
 * How Bastion identifies itself to the service behind an OAuth server (9.6). Most services let Bastion register itself;
 * some (GitHub) only accept an app registered by hand, whose client id and secret are entered here. The secret is
 * stored encrypted as a shared secret and never shown again.
 */
export function OAuthClientSection({ draft, onChange, readOnly }: EditorProps) {
  const spec = draft.spec;
  const client = spec.oauthClient;
  const { me, role } = useAuth();
  const manual = client.registration === 'preRegistered';
  const withSecret = needsClientSecret(spec);
  const secretName = oauthClientSecretName(client);
  const existing = useOrgSecretNames(withSecret);
  const isSet = existing.data?.has(secretName) ?? false;
  const set = (patch: Partial<OAuthClientDraft>) =>
    onChange(setSpec(draft, { oauthClient: { ...client, ...patch } }));
  const callback = `${me.org.baseUrl.replace(/\/$/, '')}/oauth/upstream/callback`;
  return (
    <section aria-label="OAuth app" className="flex flex-col gap-3 rounded-md bg-sunken p-3.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden="true" />
        <h3 className="m-0 text-label">OAuth app</h3>
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">How Bastion identifies itself</legend>
        {(
          [
            ['auto', 'Automatic', 'Bastion registers itself with the service'],
            ['preRegistered', 'An app I registered', 'The service needs a client ID and secret'],
          ] as const
        ).map(([value, label, help]) => (
          <label
            key={value}
            className={`flex min-h-11 items-center gap-3 rounded-md border bg-surface px-3 py-2 ${client.registration === value ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}
          >
            <input
              type="radio"
              name="oauth-registration"
              disabled={readOnly}
              checked={client.registration === value}
              onChange={() => set({ registration: value })}
              className="size-[18px] accent-[var(--tangerine-ink)]"
            />
            <span className="flex-1 text-label">{label}</span>
            <span className="text-caption text-muted">{help}</span>
          </label>
        ))}
      </fieldset>
      {manual ? (
        <>
          <p className="m-0 text-caption text-muted">
            Register an OAuth app with the service and give it this callback URL:{' '}
            <code className="break-all">{callback}</code>
          </p>
          <Field label="Client ID">
            {({ id }) => (
              <Input
                id={id}
                autoComplete="off"
                disabled={readOnly}
                value={client.clientId}
                onChange={(e) => set({ clientId: e.target.value })}
              />
            )}
          </Field>
          <Field label="How the secret is sent">
            {({ id }) => (
              <Select
                id={id}
                disabled={readOnly}
                value={client.authMethod}
                onChange={(e) =>
                  set({ authMethod: e.target.value as OAuthClientDraft['authMethod'] })
                }
              >
                <option value="client_secret_basic">Client secret, HTTP Basic (default)</option>
                <option value="client_secret_post">Client secret, in the request body</option>
                <option value="none">No secret (public client)</option>
              </Select>
            )}
          </Field>
          {withSecret ? (
            <Field
              label="Client secret"
              help={
                role !== 'admin'
                  ? 'Only an Admin can set shared secrets. Ask an Admin to enter it.'
                  : isSet
                    ? 'Set. Type to replace. Stored encrypted when you save the draft.'
                    : 'Stored encrypted when you save the draft. Never shown again.'
              }
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  aria-describedby={describedBy}
                  disabled={readOnly || role !== 'admin'}
                  value={spec.secretValues[secretName] ?? ''}
                  onChange={(e) =>
                    onChange(
                      setSpec(draft, {
                        secretValues: { ...spec.secretValues, [secretName]: e.target.value },
                      }),
                    )
                  }
                />
              )}
            </Field>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

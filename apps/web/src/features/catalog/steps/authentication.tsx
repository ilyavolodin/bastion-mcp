import * as React from 'react';
import { Field } from '@/components/form';
import { Card, CardHeader } from '@/components/primitives';
import { Input } from '@/components/ui/input';
import type { AuthMode } from '../draft';
import { type StepProps, setSpec } from './props';
import { HeadersEditor, OAuthClientSection, PackageSecrets, SecretsSection } from './secrets';

const AUTH_OPTIONS: { value: AuthMode; label: string; help: string }[] = [
  { value: 'none', label: 'None', help: 'The server needs no credentials' },
  {
    value: 'orgSecret',
    label: 'Shared secret',
    help: 'You enter the token once; everyone uses it',
  },
  {
    value: 'userSecret',
    label: 'Personal secret',
    help: 'Each person enters their own token when they install',
  },
  { value: 'oauth', label: 'OAuth', help: 'Each person signs in to the upstream' },
];

export function AuthenticationStep({ draft, onChange, readOnly }: StepProps) {
  const mode = draft.spec.authMode;
  const remote = draft.spec.type === 'remote';
  // The scopes are typed as one line; keep what was typed (a trailing space is not a scope).
  const [scopes, setScopes] = React.useState(() => draft.spec.oauthScopes.join(' '));
  const options =
    mode === 'other'
      ? [
          ...AUTH_OPTIONS,
          {
            value: 'other' as AuthMode,
            label: 'Identity provider',
            help: 'Managed by the identity provider: kept as imported',
          },
        ]
      : AUTH_OPTIONS;
  return (
    <Card aria-label="Authentication" className="gap-4">
      <CardHeader title="Authentication" subtitle="How Bastion signs in to the server" />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">Authentication mode</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 ${mode === o.value ? 'border-tangerine-ink bg-tangerine-soft' : 'border-line'}`}
          >
            <input
              type="radio"
              name="auth"
              disabled={readOnly || o.value === 'other'}
              checked={mode === o.value}
              onChange={() => onChange(setSpec(draft, { authMode: o.value }))}
              className="size-[18px] accent-[var(--tangerine-ink)]"
            />
            <span className="flex-1 text-label">{o.label}</span>
            <span className="text-caption text-muted">{o.help}</span>
          </label>
        ))}
      </fieldset>
      {mode === 'oauth' ? (
        <Field label="OAuth scopes" help="Space separated">
          {({ id }) => (
            <Input
              id={id}
              disabled={readOnly}
              value={scopes}
              onChange={(e) => {
                setScopes(e.target.value);
                onChange(
                  setSpec(draft, { oauthScopes: e.target.value.split(/\s+/).filter(Boolean) }),
                );
              }}
            />
          )}
        </Field>
      ) : null}
      {mode === 'oauth' ? (
        <OAuthClientSection draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {remote && mode !== 'other' ? (
        <HeadersEditor draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {!remote && (mode === 'orgSecret' || mode === 'userSecret' || mode === 'oauth') ? (
        <PackageSecrets draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
      {mode === 'orgSecret' || mode === 'userSecret' ? (
        <SecretsSection draft={draft} onChange={onChange} readOnly={readOnly} />
      ) : null}
    </Card>
  );
}

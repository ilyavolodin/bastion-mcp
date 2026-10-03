import { extractReferences, TemplateError, validateTemplate } from '@bastion-mcp/core/template';
import type { ArgDraft, AuthMode, BindingDraft, OAuthClientDraft, SpecDraft } from './types';

// --- templates and secrets -------------------------------------------------------------------------------------------

/** What is wrong with a value template, or undefined (`validateTemplate`, 8.1). */
export const templateError = (value: string): string | undefined => {
  try {
    validateTemplate(value);
    return undefined;
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
};

const refsIn = (value: string, namespace: string): string[] =>
  safeRefs(value)
    .filter((r) => r.startsWith(`${namespace}.`))
    .map((r) => r.slice(namespace.length + 1));

const safeRefs = (value: string): string[] => {
  try {
    return extractReferences(value);
  } catch {
    return [];
  }
};

export const secretRefsOf = (value: string): string[] => refsIn(value, 'secret');
export const varRefsOf = (value: string): string[] => refsIn(value, 'var');
export const oauthRefsOf = (value: string): string[] => refsIn(value, 'oauth');

/** Rows that carry a credential, in the order the form shows them. */
export const injectedRows = (s: SpecDraft): { name: string; value: string }[] =>
  s.type === 'remote'
    ? s.headers.filter((h) => h.secret)
    : [...s.envVars.filter((e) => e.secret), ...s.args.filter((a) => a.secret)];

/** The secrets the spec refers to (`{{secret.NAME}}` in a binding marked secret), first appearance first. */
export const secretNamesOf = (s: SpecDraft): string[] => [
  ...new Set(injectedRows(s).flatMap((r) => secretRefsOf(r.value))),
];

/** The shared secret that holds the client secret of a pre-registered OAuth app, one per client id. */
export const oauthClientSecretName = (c: OAuthClientDraft): string =>
  `OAUTH_CLIENT_SECRET_${c.clientId
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()}`;

/** Whether this spec keeps a client secret in the org secrets. */
export const needsClientSecret = (s: SpecDraft): boolean =>
  s.authMode === 'oauth' &&
  s.oauthClient.registration === 'preRegistered' &&
  s.oauthClient.authMethod !== 'none';

/** The value template that refers to a secret by name (resolved by the credential resolver, 9.5). */
export const secretTemplate = (name: string): string => `{{secret.${name}}}`;

/** The value template of the upstream access token of an OAuth server (9.6). */
export const oauthTokenTemplate = (): string => '{{oauth.accessToken}}';

/** What an `Authorization` header puts before the credential. */
export const BEARER_PREFIX = 'Bearer ';

/** `Authorization` carries a bearer token; any other header an API key. */
export const defaultSecretValue = (headerName: string, taken: readonly string[] = []): string => {
  const bearer = headerName.trim().toLowerCase() === 'authorization';
  const base = bearer ? 'TOKEN' : 'API_KEY';
  let name = base;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}_${n}`;
  return `${bearer ? BEARER_PREFIX : ''}${secretTemplate(name)}`;
};

export type HeaderPreset = 'bearer' | 'apiKey' | 'custom';

/** The rows the "Add header" presets create (9.5). Names of secrets already used stay unique. */
export const headerPreset = (kind: HeaderPreset, s: SpecDraft): BindingDraft => {
  const taken = secretNamesOf(s);
  if (kind === 'bearer')
    return {
      name: 'Authorization',
      value: defaultSecretValue('Authorization', taken),
      secret: true,
    };
  if (kind === 'apiKey')
    return { name: 'X-API-Key', value: defaultSecretValue('X-API-Key', taken), secret: true };
  return { name: '', value: '', secret: false };
};

/** Turns the Secret switch of a row on or off; switching on fills in a `{{secret.NAME}}` template. */
export const setRowSecret = <T extends { name: string; value: string; secret: boolean }>(
  row: T,
  on: boolean,
  taken: readonly string[],
  mode: AuthMode = 'userSecret',
): T => {
  if (!on) {
    const cleared = refsIn(row.value, 'secret').length > 0 || refsIn(row.value, 'oauth').length > 0;
    return { ...row, secret: false, value: cleared ? '' : row.value };
  }
  const hasRef =
    refsIn(row.value, 'secret').length > 0 ||
    (mode === 'oauth' && refsIn(row.value, 'oauth').length > 0);
  if (hasRef) return { ...row, secret: true };
  if (mode === 'oauth') return { ...row, secret: true, value: oauthTokenTemplate() };
  return { ...row, secret: true, value: defaultSecretValue(row.name, taken) };
};

/** Prefix of the names given to secrets that an "Add secret" button creates: `SECRET_1`, `SECRET_2`... */
export const SECRET_NAME_PREFIX = 'SECRET_';
/** The command-line flag and secret name of the "Add secret argument" button. */
export const DEFAULT_SECRET_ARG = { flag: '--token', secret: 'TOKEN' } as const;

/**
 * The spec with one more header from a preset (9.5). A credential header needs a place the secret comes from: when
 * the auth mode is not already a secret mode, it becomes a shared secret.
 */
export const addHeaderPreset = (s: SpecDraft, kind: HeaderPreset): SpecDraft => {
  const row = headerPreset(kind, s);
  const authMode =
    row.secret && s.authMode !== 'orgSecret' && s.authMode !== 'userSecret'
      ? 'orgSecret'
      : s.authMode;
  return { ...s, headers: [...s.headers, row], authMode };
};

/** The value template of a new secret binding: the access token for OAuth, else a secret reference. */
const credentialTemplate = (mode: AuthMode, secretName: string): string =>
  mode === 'oauth' ? oauthTokenTemplate() : secretTemplate(secretName);

/** The spec with one more secret environment variable (a name to fill in, a fresh `SECRET_n` reference). */
export const addSecretEnv = (s: SpecDraft): SpecDraft => {
  const taken = secretNamesOf(s);
  let n = taken.length + 1;
  while (taken.includes(`${SECRET_NAME_PREFIX}${n}`)) n += 1;
  const row: BindingDraft = {
    name: '',
    secret: true,
    value: credentialTemplate(s.authMode, `${SECRET_NAME_PREFIX}${n}`),
  };
  return { ...s, envVars: [...s.envVars, row] };
};

/** The spec with one more secret command-line argument (`--token`). */
export const addSecretArg = (s: SpecDraft): SpecDraft => {
  const row: ArgDraft = {
    kind: 'named',
    name: DEFAULT_SECRET_ARG.flag,
    secret: true,
    value: credentialTemplate(s.authMode, DEFAULT_SECRET_ARG.secret),
  };
  return { ...s, args: [...s.args, row] };
};

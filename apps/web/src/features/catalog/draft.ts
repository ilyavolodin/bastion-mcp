/**
 * The catalog editor's form state and the pure functions that turn it into API bodies. The server spec follows the
 * real `ServerSpec` (`packages/core/src/server-spec.ts`): its constraints are mirrored here because that module is
 * Node-only, and the contract test validates the serialized bodies against the OpenAPI schema with ajv.
 *
 * How the form maps to the spec (8.1, 9.5):
 *
 * - `variables` are what installers fill in. They become the install form and, for a remote server, `spec.variables`
 *   (`{{var.NAME}}` in the URL and headers).
 * - `headers` (remote), `envVars` and `args` (package) are bindings of a value template to a place in the request or
 *   the process. A plain binding goes to `spec.headers`, `environmentVariables` and `packageArguments`. A binding
 *   marked secret goes to `auth.inject` instead, because only the credential resolver can supply `{{secret.NAME}}`:
 *   with `orgSecret` the name is an org secret that the author sets once, with `userSecret` it is a field each
 *   installer fills in (`auth.fields`).
 */
import { slugify } from '@bastion-mcp/core/ids';
import { extractReferences, TemplateError, validateTemplate } from '@bastion-mcp/core/template';
import type { Body, DriftPolicy, RiskLevel } from '@/api/schema';
import type {
  CatalogEntry,
  CatalogVersion,
  InstallFormBody,
  ServerSpecBody,
} from '@/api/views/catalog';

export type EntryCreateBody = Body<'post', '/catalog'>;
export type EntryPatchBody = Body<'patch', '/catalog/{id}'>;
export type VersionCreateBody = Body<'post', '/catalog/{id}/versions'>;
export type UserOverrides = NonNullable<EntryCreateBody['userOverrides']>;
export type Visibility = CatalogEntry['visibility'];

/** An install-form input (11.4): asked when someone installs, referenced as `{{var.NAME}}`. */
export type VariableDraft = {
  name: string;
  label: string;
  description: string;
  required: boolean;
  default: string;
  /** Comma separated; empty means free text. */
  choices: string;
};

/** A header or an environment variable: a name and a value template. */
export type BindingDraft = {
  name: string;
  value: string;
  /** The value carries a credential (`{{secret.NAME}}` or `{{oauth.accessToken}}`): injected by the gateway. */
  secret: boolean;
  /** Fields of a loaded entry that the form does not edit (description, isRequired...). */
  raw?: Record<string, unknown>;
};

export type ArgDraft = {
  kind: 'positional' | 'named';
  /** The flag of a named argument (`--region`). */
  name: string;
  value: string;
  secret: boolean;
  raw?: Record<string, unknown>;
};

/** `other` is a mode the editor does not edit (`enterpriseManaged`, `tokenExchange`): kept as loaded. */
export type AuthMode = 'none' | 'orgSecret' | 'userSecret' | 'oauth' | 'other';

export type SpecDraft = {
  type: 'package' | 'remote';
  runtime: 'npm' | 'pypi';
  identifier: string;
  version: string;
  transport: 'streamable-http' | 'sse';
  url: string;
  variables: VariableDraft[];
  /** Remote servers: request headers. */
  headers: BindingDraft[];
  /** Packages: environment variables of the server process. */
  envVars: BindingDraft[];
  /** Packages: command-line arguments. */
  args: ArgDraft[];
  authMode: AuthMode;
  oauthScopes: string[];
  /** Labels of the per-user secret fields (`userSecret`), by secret name. */
  secretLabels: Record<string, string>;
  /**
   * Values of the shared secrets (`orgSecret`) typed in this session. Never part of the spec: the editor writes them
   * through the secrets API and forgets them.
   */
  secretValues: Record<string, string>;
  egress: string[];
  size: 'small' | 'medium' | 'large';
  /** The spec as loaded: fields the editor does not own (timeouts, lockfile...) are kept on save. */
  base: Record<string, unknown> | null;
};

export type Draft = {
  displayName: string;
  slug: string;
  description: string;
  /** The team that owns the entry (11.1); null means the organization. Fixed once the entry exists. */
  ownerTeamId: string | null;
  visibility: Visibility;
  risk: RiskLevel;
  autoUpgrade: boolean;
  userOverrides: UserOverrides;
  onDrift: DriftPolicy;
  /** The version label (`1.4.0`), unique within the entry. */
  label: string;
  /** Default overrides of the version (12), edited as JSON. */
  overrides: Record<string, unknown>;
  /** What is wrong with the text in the overrides editor; the draft keeps the last valid document meanwhile. */
  overridesError?: string | undefined;
  spec: SpecDraft;
};

export const defaultSpec = (): SpecDraft => ({
  type: 'package',
  runtime: 'npm',
  identifier: '',
  version: '0.1.0',
  transport: 'streamable-http',
  url: '',
  variables: [],
  headers: [],
  envVars: [],
  args: [],
  authMode: 'none',
  oauthScopes: [],
  secretLabels: {},
  secretValues: {},
  egress: [],
  size: 'small',
  base: null,
});

export const emptyDraft = (): Draft => ({
  displayName: '',
  slug: '',
  description: '',
  ownerTeamId: null,
  visibility: { org: false, teamIds: [], userIds: [] },
  risk: 'low',
  autoUpgrade: true,
  userOverrides: 'cosmetic',
  onDrift: 'hideChanged',
  label: '0.1.0',
  overrides: { version: 1 },
  spec: defaultSpec(),
});

export const emptyVariable = (): VariableDraft => ({
  name: '',
  label: '',
  description: '',
  required: true,
  default: '',
  choices: '',
});

// --- constraints (mirrors of the API schemas) ------------------------------------------------------------------

/** `EXACT_VERSION` of `packages/core/src/server-spec.ts` (8.7): ranges, tags and `latest` are rejected. */
export const EXACT_VERSION = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
/** Names of `{{var.NAME}}` and `{{secret.NAME}}` references (`packages/core/src/template.ts`). */
export const TEMPLATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP field name (RFC 9110 token). */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `host[:port]`, `*.suffix[:port]` or a CIDR (`isValidEgressRule`, 8.8). */
export const isEgressRule = (raw: string): boolean => {
  const value = raw.trim().toLowerCase();
  if (value.includes('/')) {
    const [net = '', prefix = ''] = value.split('/');
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(net);
    const v6 = net.includes(':') && /^[0-9a-f:.]+$/.test(net);
    return /^\d+$/.test(prefix) && ((v4 && Number(prefix) <= 32) || (v6 && Number(prefix) <= 128));
  }
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(value);
  const host = m?.[1] ?? '';
  if (m?.[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return false;
  if (host.startsWith('*.')) return HOSTNAME.test(host.slice(2));
  return HOSTNAME.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
};

export const LIMITS = {
  displayName: 200,
  slug: 63,
  description: 4000,
  label: 64,
  changelog: 10000,
} as const;

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
const oauthRefsOf = (value: string): string[] => refsIn(value, 'oauth');

/** Rows that carry a credential, in the order the form shows them. */
const injectedRows = (s: SpecDraft): { name: string; value: string }[] =>
  s.type === 'remote'
    ? s.headers.filter((h) => h.secret)
    : [...s.envVars.filter((e) => e.secret), ...s.args.filter((a) => a.secret)];

/** The secrets the spec refers to (`{{secret.NAME}}` in a binding marked secret), first appearance first. */
export const secretNamesOf = (s: SpecDraft): string[] => [
  ...new Set(injectedRows(s).flatMap((r) => secretRefsOf(r.value))),
];

/** `Authorization` carries a bearer token; any other header an API key. */
export const defaultSecretValue = (headerName: string, taken: readonly string[] = []): string => {
  const bearer = headerName.trim().toLowerCase() === 'authorization';
  const base = bearer ? 'TOKEN' : 'API_KEY';
  let name = base;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}_${n}`;
  return `${bearer ? 'Bearer ' : ''}{{secret.${name}}}`;
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
  if (mode === 'oauth') return { ...row, secret: true, value: '{{oauth.accessToken}}' };
  return { ...row, secret: true, value: defaultSecretValue(row.name, taken) };
};

// --- validation -------------------------------------------------------------------------------------------------------

export type Issue = { step: string; message: string };

const looksSecretMode = (m: AuthMode) => m === 'orgSecret' || m === 'userSecret';

/** Every reason the draft cannot be saved, with the step that fixes it. */
export const validateDraft = (d: Draft): Issue[] => {
  const issues: Issue[] = [];
  const add = (step: string, message: string) => issues.push({ step, message });
  if (!d.displayName.trim()) add('source', 'Give the entry a name');
  if (d.displayName.trim().length > LIMITS.displayName) add('source', 'The name is too long');
  if (!d.slug || d.slug.length > LIMITS.slug)
    add('source', 'The URL name needs 1 to 63 characters');
  if (d.description.length > LIMITS.description) add('source', 'The description is too long');
  if (!d.label.trim() || d.label.length > LIMITS.label)
    add('source', 'The version label needs 1 to 64 characters');
  if (d.overridesError) add('overrides', `The override document is not valid: ${d.overridesError}`);
  const s = d.spec;
  if (s.type === 'package') {
    if (!s.identifier.trim()) add('source', 'Name the package');
    if (!EXACT_VERSION.test(s.version))
      add('source', 'Pin an exact package version, for example 3.2.0');
  } else if (!s.url.trim()) add('source', 'Give the server URL');

  const declared = new Set(s.variables.map((v) => v.name));
  const names = new Set<string>();
  for (const v of s.variables) {
    if (!TEMPLATE_NAME.test(v.name))
      add('configuration', `"${v.name || '(empty)'}" is not a valid variable name`);
    if (names.has(v.name)) add('configuration', `${v.name} is declared twice`);
    names.add(v.name);
    const choices = splitChoices(v.choices);
    if (v.default && choices.length > 0 && !choices.includes(v.default))
      add('configuration', `The default of ${v.name} is not one of its choices`);
  }

  const checkTemplate = (step: string, where: string, value: string) => {
    const error = templateError(value);
    if (error) {
      add(step, `${where}: ${error}`);
      return;
    }
    for (const ref of varRefsOf(value)) {
      if (!declared.has(ref)) add(step, `${where} uses {{var.${ref}}}, which is not a variable`);
    }
  };

  if (s.type === 'remote') checkTemplate('source', 'The server URL', s.url);

  const seenHeaders = new Set<string>();
  if (s.type === 'remote') {
    for (const h of s.headers) {
      const label = h.name ? `Header ${h.name}` : 'A header';
      if (!HEADER_NAME.test(h.name))
        add('authentication', `"${h.name}" is not a valid header name`);
      else if (seenHeaders.has(h.name.toLowerCase()))
        add('authentication', `Header ${h.name} is declared twice`);
      seenHeaders.add(h.name.toLowerCase());
      if (!h.value.trim()) add('authentication', `${label} needs a value`);
      else checkTemplate('authentication', label, h.value);
    }
  } else {
    const seenEnv = new Set<string>();
    for (const e of s.envVars) {
      const label = e.name ? `Environment variable ${e.name}` : 'An environment variable';
      if (!TEMPLATE_NAME.test(e.name))
        add('configuration', `"${e.name || '(empty)'}" is not a valid environment variable name`);
      else if (seenEnv.has(e.name)) add('configuration', `${e.name} is set twice`);
      seenEnv.add(e.name);
      if (!e.value.trim() && !e.secret) add('configuration', `${label} needs a value`);
      else checkTemplate('configuration', label, e.value);
    }
    for (const a of s.args) {
      const label = a.name ? `Argument ${a.name}` : 'An argument';
      if (a.kind === 'named' && !a.name.trim())
        add('configuration', 'A named argument needs a flag');
      if (!a.value.trim()) add('configuration', `${label} needs a value`);
      else checkTemplate('configuration', label, a.value);
    }
  }

  // Credentials (9.5).
  const injected = injectedRows(s);
  const secretNames = secretNamesOf(s);
  for (const row of injected) {
    const where = row.name ? `"${row.name}"` : 'A secret binding';
    if (s.authMode === 'oauth') {
      if (oauthRefsOf(row.value).length === 0 && secretRefsOf(row.value).length === 0)
        add('authentication', `${where} is marked secret but its value has no reference`);
    } else if (secretRefsOf(row.value).length === 0) {
      add('authentication', `${where} is marked secret: its value needs {{secret.NAME}}`);
    }
  }
  const plain = (s.type === 'remote' ? s.headers : [...s.envVars, ...s.args]).filter(
    (r) => !r.secret,
  );
  for (const row of plain) {
    if (secretRefsOf(row.value).length > 0)
      add(
        'authentication',
        `${row.name ? `"${row.name}"` : 'A value'} uses a secret: switch Secret on for it`,
      );
  }
  for (const name of secretNames) {
    if (!TEMPLATE_NAME.test(name))
      add('authentication', `"${name}" is not a valid secret name (letters, digits, underscore)`);
  }
  if (secretNames.length > 0 && !looksSecretMode(s.authMode))
    add(
      'authentication',
      'Secrets need an author-set or per-person source: choose Shared secret or Personal secret',
    );
  if (looksSecretMode(s.authMode) && secretNames.length === 0)
    add(
      'authentication',
      s.type === 'remote'
        ? 'Add a header that carries the secret, for example a Bearer token'
        : 'Add an environment variable or argument that carries the secret',
    );
  if (s.authMode === 'oauth' && s.type === 'package' && injected.length === 0)
    add('authentication', 'Say where the access token goes: add a secret environment variable');
  for (const rule of s.egress)
    if (!isEgressRule(rule))
      add('network', `"${rule}" is not host[:port], *.suffix[:port] or a CIDR`);
  return issues;
};

export const splitChoices = (raw: string): string[] =>
  raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

// --- draft to API bodies -----------------------------------------------------------------------------------------

type Injection = NonNullable<
  Extract<ServerSpecBody['auth'], { mode: 'orgSecret' }>['inject']
>[number];

/** Secret bindings as `auth.inject` rules (8.1, 9.5). */
const injectionsOf = (s: SpecDraft): Injection[] =>
  s.type === 'remote'
    ? s.headers
        .filter((h) => h.secret)
        .map((h) => ({ to: 'header' as const, name: h.name, value: h.value }))
    : [
        ...s.envVars
          .filter((e) => e.secret)
          .map((e) => ({ to: 'env' as const, name: e.name, value: e.value })),
        ...s.args
          .filter((a) => a.secret)
          .map((a) =>
            a.kind === 'named'
              ? { to: 'arg' as const, flag: a.name, value: a.value }
              : { to: 'arg' as const, value: a.value },
          ),
      ];

const authOf = (s: SpecDraft): ServerSpecBody['auth'] => {
  switch (s.authMode) {
    case 'none':
      return { mode: 'none' };
    case 'orgSecret':
      return { mode: 'orgSecret', inject: injectionsOf(s) };
    case 'userSecret':
      return {
        mode: 'userSecret',
        fields: secretNamesOf(s).map((name) => ({
          name,
          label: s.secretLabels[name]?.trim() || name,
        })),
        inject: injectionsOf(s),
      };
    case 'oauth': {
      const inject = injectionsOf(s);
      return {
        mode: 'oauth',
        client: { registration: 'auto' },
        ...(s.oauthScopes.length ? { scopes: s.oauthScopes } : {}),
        ...(inject.length > 0
          ? { inject }
          : s.type === 'remote'
            ? {
                inject: [
                  {
                    to: 'header' as const,
                    name: 'Authorization',
                    value: 'Bearer {{oauth.accessToken}}',
                  },
                ],
              }
            : {}),
      };
    }
    case 'other':
      return (s.base?.auth ?? { mode: 'none' }) as ServerSpecBody['auth'];
  }
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const OWNED = new Set([
  'type',
  'runtime',
  'identifier',
  'version',
  'transport',
  'url',
  'variables',
  'headers',
  'environmentVariables',
  'packageArguments',
  'auth',
  'egress',
  'size',
]);

const variableSpec = (v: VariableDraft) => ({
  name: v.name,
  isRequired: v.required,
  ...(v.default ? { default: v.default } : {}),
  ...(v.label || v.description ? { description: v.label || v.description } : {}),
  ...(splitChoices(v.choices).length ? { choices: splitChoices(v.choices) } : {}),
});

/** The real `ServerSpec` of the draft; fields the editor does not own are kept from the loaded spec. */
export const draftToSpec = (s: SpecDraft): ServerSpecBody => {
  const kept = Object.fromEntries(
    Object.entries(s.base?.type === s.type ? s.base : {}).filter(([k]) => !OWNED.has(k)),
  );
  if (s.type === 'package') {
    const plainEnv = s.envVars.filter((e) => !e.secret);
    const plainArgs = s.args.filter((a) => !a.secret);
    return {
      ...kept,
      type: 'package',
      runtime: s.runtime,
      identifier: s.identifier.trim(),
      version: s.version.trim(),
      size: s.size,
      egress: { allow: s.egress },
      // Absent stays absent: a spec without them must not look edited (the test of a version is cleared on change).
      ...(plainEnv.length || (s.base && 'environmentVariables' in s.base)
        ? {
            environmentVariables: plainEnv.map((e) => ({ ...e.raw, name: e.name, value: e.value })),
          }
        : {}),
      ...(plainArgs.length
        ? {
            packageArguments: plainArgs.map((a) => ({
              ...a.raw,
              type: a.kind,
              ...(a.kind === 'named' ? { name: a.name } : {}),
              value: a.value,
            })),
          }
        : {}),
      auth: authOf(s),
    } as ServerSpecBody;
  }
  const plainHeaders = s.headers.filter((h) => !h.secret);
  return {
    ...kept,
    type: 'remote',
    transport: s.transport,
    url: s.url.trim(),
    variables: Object.fromEntries(s.variables.map((v) => [v.name, variableSpec(v)])),
    ...(plainHeaders.length
      ? { headers: plainHeaders.map((h) => ({ ...h.raw, name: h.name, value: h.value })) }
      : {}),
    auth: authOf(s),
  } as ServerSpecBody;
};

/** The install form the spec implies (11.4): the variables, and the per-user secrets of `userSecret`. */
export const installFormOf = (s: SpecDraft): InstallFormBody => ({
  variables: s.variables.map((v) => ({
    name: v.name,
    label: v.label || v.name,
    ...(v.description ? { description: v.description } : {}),
    required: v.required,
    ...(v.default ? { default: v.default } : {}),
    ...(splitChoices(v.choices).length ? { choices: splitChoices(v.choices) } : {}),
  })),
  secrets:
    s.authMode === 'userSecret'
      ? secretNamesOf(s).map((name) => ({ name, label: s.secretLabels[name]?.trim() || name }))
      : [],
});

const visibilityBody = (v: Visibility): Visibility => ({
  org: v.org,
  teamIds: v.teamIds,
  userIds: v.userIds,
});

export const toEntryCreateBody = (d: Draft): EntryCreateBody => ({
  slug: d.slug,
  kind: 'mcp_server',
  displayName: d.displayName.trim(),
  description: d.description,
  ...(d.ownerTeamId ? { ownerTeamId: d.ownerTeamId } : {}),
  visibility: visibilityBody(d.visibility),
  risk: d.risk,
  userOverrides: d.userOverrides,
  onDrift: d.onDrift,
  autoUpgrade: d.autoUpgrade,
});

export const toEntryPatchBody = (d: Draft): EntryPatchBody => ({
  displayName: d.displayName.trim(),
  description: d.description,
  visibility: visibilityBody(d.visibility),
  risk: d.risk,
  userOverrides: d.userOverrides,
  onDrift: d.onDrift,
  autoUpgrade: d.autoUpgrade,
});

export const toVersionBody = (d: Draft): VersionCreateBody => ({
  label: d.label.trim(),
  serverSpec: draftToSpec(d.spec),
  installForm: installFormOf(d.spec),
  changelog: null,
});

// --- stored rows to a draft ----------------------------------------------------------------------------------------

const authModeOf = (auth: Record<string, unknown>): AuthMode =>
  auth.mode === 'orgSecret' || auth.mode === 'userSecret' || auth.mode === 'oauth'
    ? auth.mode
    : auth.mode === 'none' || auth.mode === undefined
      ? 'none'
      : 'other';

const rawRest = (entry: Record<string, unknown>, owned: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entry).filter(([k]) => !owned.includes(k)));

const variableFrom = (v: Record<string, unknown>, name: string): VariableDraft => ({
  name,
  label: str(v.label) || str(v.description),
  description: str(v.label) ? str(v.description) : '',
  required: v.required === undefined ? v.isRequired !== false : v.required !== false,
  default: str(v.default),
  choices: list(v.choices).map(String).join(', '),
});

/** The install-form variables of a stored version; older versions without a form derive them from the spec. */
const variablesOf = (
  s: Record<string, unknown>,
  form: Record<string, unknown>,
): VariableDraft[] => {
  const fromForm = list(form.variables)
    .map(rec)
    .filter((v) => typeof v.name === 'string')
    .map((v) => variableFrom(v, str(v.name)));
  if (fromForm.length > 0) return fromForm;
  if (s.type === 'remote')
    return Object.entries(rec(s.variables)).map(([name, raw]) => variableFrom(rec(raw), name));
  return list(s.environmentVariables)
    .map(rec)
    .filter((e) => typeof e.name === 'string' && e.value === `{{var.${e.name}}}`)
    .map((e) => variableFrom(e, str(e.name)));
};

const injectedBinding = (r: Record<string, unknown>): BindingDraft => ({
  name: str(r.name),
  value: str(r.value),
  secret: true,
});

/** Reads a stored `serverSpec` back into the editor (anything it does not understand stays in `base`). */
export const specToDraft = (spec: unknown, installForm?: unknown): SpecDraft => {
  const s = rec(spec);
  if (Object.keys(s).length === 0) return defaultSpec();
  const auth = rec(s.auth);
  const authMode = authModeOf(auth);
  const inject = list(auth.inject).map(rec);
  const injectsSecrets = authMode === 'orgSecret' || authMode === 'userSecret';
  const injectsCredential = injectsSecrets || authMode === 'oauth';
  const remote = s.type === 'remote';
  // The default `Authorization: Bearer {{oauth.accessToken}}` of a remote OAuth server is implied, not a row.
  const impliedOauth = (r: Record<string, unknown>) =>
    remote &&
    authMode === 'oauth' &&
    r.to === 'header' &&
    str(r.name).toLowerCase() === 'authorization' &&
    r.value === 'Bearer {{oauth.accessToken}}';

  const plainBinding = (raw: unknown): BindingDraft => {
    const e = rec(raw);
    return {
      name: str(e.name),
      value: typeof e.value === 'string' ? e.value : str(e.default),
      secret: false,
      raw: rawRest(e, ['name', 'value']),
    };
  };
  const headers: BindingDraft[] = remote
    ? [
        ...list(s.headers).map(plainBinding),
        ...(injectsCredential
          ? inject.filter((r) => r.to === 'header' && !impliedOauth(r)).map(injectedBinding)
          : []),
      ]
    : [];
  const injectedEnv = new Set(inject.filter((r) => r.to === 'env').map((r) => str(r.name)));
  const envVars: BindingDraft[] = remote
    ? []
    : [
        ...list(s.environmentVariables)
          .map(plainBinding)
          // A plain entry that only repeats an injected secret (`DB = {{secret.DB}}`) is the injection's duplicate.
          .filter(
            (e) =>
              e.name !== '' &&
              !(injectsCredential && injectedEnv.has(e.name) && secretRefsOf(e.value).length > 0),
          ),
        ...(injectsCredential ? inject.filter((r) => r.to === 'env').map(injectedBinding) : []),
      ];
  const args: ArgDraft[] = remote
    ? []
    : [
        ...list(s.packageArguments).map((raw) => {
          const a = rec(raw);
          return {
            kind: a.type === 'named' ? ('named' as const) : ('positional' as const),
            name: str(a.name),
            value: str(a.value),
            secret: false,
            raw: rawRest(a, ['type', 'name', 'value']),
          };
        }),
        ...(injectsCredential
          ? inject
              .filter((r) => r.to === 'arg')
              .map((r) => ({
                kind:
                  typeof r.flag === 'string' && r.flag
                    ? ('named' as const)
                    : ('positional' as const),
                name: str(r.flag),
                value: str(r.value),
                secret: true,
              }))
          : []),
      ];
  const secretLabels = Object.fromEntries(
    list(auth.fields)
      .map(rec)
      .map((f) => [str(f.name), str(f.label)] as const)
      .filter(([name, label]) => name !== '' && label !== '' && label !== name),
  );
  return {
    type: remote ? 'remote' : 'package',
    runtime: s.runtime === 'pypi' ? 'pypi' : 'npm',
    identifier: str(s.identifier),
    version: str(s.version),
    transport: s.transport === 'sse' ? 'sse' : 'streamable-http',
    url: str(s.url),
    variables: variablesOf(s, rec(installForm)),
    headers,
    envVars,
    args,
    authMode,
    oauthScopes: list(auth.scopes).map(String),
    secretLabels,
    secretValues: {},
    egress: list(rec(s.egress).allow).map(String),
    size: s.size === 'medium' || s.size === 'large' ? s.size : 'small',
    base: s,
  };
};

export const draftOf = (
  entry: CatalogEntry,
  version: CatalogVersion | undefined,
  label: string,
): Draft => ({
  displayName: entry.displayName,
  slug: entry.slug,
  description: entry.description,
  ownerTeamId: entry.ownerTeamId ?? null,
  visibility: entry.visibility,
  risk: entry.risk,
  autoUpgrade: entry.autoUpgrade,
  userOverrides: entry.userOverrides,
  onDrift: entry.onDrift,
  label,
  overrides: normalizeOverrides(version?.overrides),
  spec: version?.serverSpec ? specToDraft(version.serverSpec, version.installForm) : defaultSpec(),
});

/** A version without overrides stores `{}` (or nothing): the editor works on the empty document `{ version: 1 }`. */
export const normalizeOverrides = (stored: unknown): Record<string, unknown> => {
  const doc = rec(stored);
  return Object.keys(doc).length === 0 ? { version: 1 } : doc;
};

export { slugify };

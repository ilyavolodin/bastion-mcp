/**
 * The catalog editor's form state and the pure functions that turn it into API bodies. The server spec follows the
 * real `ServerSpec` (`packages/core/src/server-spec.ts`): its constraints are mirrored here because that module is
 * Node-only, and the contract test validates the serialized bodies against the OpenAPI schema with ajv.
 */
import { slugify } from '@bastion-mcp/core/ids';
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

export type VariableDraft = {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
  default: string;
};

export type AuthMode = 'none' | 'orgSecret' | 'userSecret' | 'oauth';

export type SpecDraft = {
  type: 'package' | 'remote';
  runtime: 'npm' | 'pypi';
  identifier: string;
  version: string;
  transport: 'streamable-http' | 'sse';
  url: string;
  variables: VariableDraft[];
  authMode: AuthMode;
  oauthScopes: string[];
  /** Name of the org secret injected for `orgSecret`. */
  orgSecretName: string;
  egress: string[];
  size: 'small' | 'medium' | 'large';
  /** The spec as loaded: fields the editor does not own (headers, timeouts, lockfile...) are kept on save. */
  base: Record<string, unknown> | null;
};

export type Draft = {
  displayName: string;
  slug: string;
  description: string;
  visibility: Visibility;
  risk: RiskLevel;
  autoUpgrade: boolean;
  userOverrides: UserOverrides;
  onDrift: DriftPolicy;
  /** The version label (`1.4.0`), unique within the entry. */
  label: string;
  /** Default overrides of the version (12), edited as JSON. */
  overrides: Record<string, unknown>;
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
  authMode: 'none',
  oauthScopes: [],
  orgSecretName: '',
  egress: [],
  size: 'small',
  base: null,
});

export const emptyDraft = (): Draft => ({
  displayName: '',
  slug: '',
  description: '',
  visibility: { org: false, teamIds: [], userIds: [] },
  risk: 'low',
  autoUpgrade: true,
  userOverrides: 'cosmetic',
  onDrift: 'hideChanged',
  label: '0.1.0',
  overrides: { version: 1 },
  spec: defaultSpec(),
});

// --- constraints (mirrors of the API schemas) ------------------------------------------------------------------

/** `EXACT_VERSION` of `packages/core/src/server-spec.ts` (8.7): ranges, tags and `latest` are rejected. */
export const EXACT_VERSION = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
/** Names of `{{var.NAME}}` and `{{secret.NAME}}` references (`packages/core/src/template.ts`). */
export const TEMPLATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

export type Issue = { step: string; message: string };

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
  const s = d.spec;
  if (s.type === 'package') {
    if (!s.identifier.trim()) add('source', 'Name the package');
    if (!EXACT_VERSION.test(s.version))
      add('source', 'Pin an exact package version, for example 3.2.0');
  } else if (!s.url.trim()) add('source', 'Give the server URL');
  const names = new Set<string>();
  for (const v of s.variables) {
    if (!TEMPLATE_NAME.test(v.name))
      add('configuration', `"${v.name || '(empty)'}" is not a valid variable name`);
    if (names.has(v.name)) add('configuration', `${v.name} is declared twice`);
    names.add(v.name);
  }
  const secrets = s.variables.filter((v) => v.secret);
  if (s.authMode === 'userSecret' && secrets.length === 0)
    add('authentication', 'A personal API key needs at least one secret variable');
  if (s.authMode !== 'userSecret' && secrets.length > 0)
    add('authentication', 'Secret variables need the personal API key mode');
  if (s.authMode === 'orgSecret' && !TEMPLATE_NAME.test(s.orgSecretName))
    add('authentication', 'Name the shared secret (letters, digits and underscore)');
  for (const rule of s.egress)
    if (!isEgressRule(rule))
      add('network', `"${rule}" is not host[:port], *.suffix[:port] or a CIDR`);
  return issues;
};

// --- draft to API bodies -----------------------------------------------------------------------------------------

type Injection = NonNullable<
  Extract<ServerSpecBody['auth'], { mode: 'orgSecret' }>['inject']
>[number];

const secretInjection = (type: SpecDraft['type'], name: string): Injection =>
  type === 'package'
    ? { to: 'env', name, value: `{{secret.${name}}}` }
    : { to: 'header', name: type === 'remote' ? name : name, value: `{{secret.${name}}}` };

const authOf = (s: SpecDraft): ServerSpecBody['auth'] => {
  switch (s.authMode) {
    case 'none':
      return { mode: 'none' };
    case 'orgSecret':
      return { mode: 'orgSecret', inject: [secretInjection(s.type, s.orgSecretName)] };
    case 'userSecret': {
      const secrets = s.variables.filter((v) => v.secret);
      return {
        mode: 'userSecret',
        fields: secrets.map((v) => ({ name: v.name, label: v.label || v.name })),
        inject: secrets.map((v) => secretInjection(s.type, v.name)),
      };
    }
    case 'oauth':
      return {
        mode: 'oauth',
        client: { registration: 'auto' },
        ...(s.oauthScopes.length ? { scopes: s.oauthScopes } : {}),
        ...(s.type === 'remote'
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
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** An environment variable that the editor owns: `NAME = {{var.NAME}}`. */
const isVarInput = (env: Record<string, unknown>): boolean =>
  typeof env.name === 'string' && env.value === `{{var.${env.name}}}`;

const OWNED = new Set([
  'type',
  'runtime',
  'identifier',
  'version',
  'transport',
  'url',
  'variables',
  'environmentVariables',
  'auth',
  'egress',
  'size',
]);

/** The real `ServerSpec` of the draft; fields the editor does not own are kept from the loaded spec. */
export const draftToSpec = (s: SpecDraft): ServerSpecBody => {
  const kept = Object.fromEntries(
    Object.entries(s.base?.type === s.type ? s.base : {}).filter(([k]) => !OWNED.has(k)),
  );
  const plain = s.variables.filter((v) => !v.secret);
  if (s.type === 'package') {
    // Environment variables that are not `{{var.NAME}}` inputs (a secret injected by hand, a fixed value) stay.
    const preserved = list(s.base?.type === 'package' ? s.base.environmentVariables : []).filter(
      (raw) => !isVarInput(rec(raw)),
    );
    return {
      ...kept,
      type: 'package',
      runtime: s.runtime,
      identifier: s.identifier.trim(),
      version: s.version.trim(),
      size: s.size,
      egress: { allow: s.egress },
      environmentVariables: [
        ...preserved,
        ...plain.map((v) => ({
          name: v.name,
          value: `{{var.${v.name}}}`,
          isRequired: v.required,
          ...(v.default ? { default: v.default } : {}),
          ...(v.label ? { description: v.label } : {}),
        })),
      ],
      auth: authOf(s),
    } as ServerSpecBody;
  }
  return {
    ...kept,
    type: 'remote',
    transport: s.transport,
    url: s.url.trim(),
    variables: Object.fromEntries(
      plain.map((v) => [
        v.name,
        {
          name: v.name,
          isRequired: v.required,
          ...(v.default ? { default: v.default } : {}),
          ...(v.label ? { description: v.label } : {}),
        },
      ]),
    ),
    auth: authOf(s),
  } as ServerSpecBody;
};

/** The install form the spec implies (11.4): plain variables and per-user secrets. */
export const installFormOf = (s: SpecDraft): InstallFormBody => ({
  variables: s.variables
    .filter((v) => !v.secret)
    .map((v) => ({
      name: v.name,
      label: v.label || v.name,
      required: v.required,
      ...(v.default ? { default: v.default } : {}),
    })),
  secrets:
    s.authMode === 'userSecret'
      ? s.variables.filter((v) => v.secret).map((v) => ({ name: v.name, label: v.label || v.name }))
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
    : 'none';

/** Reads a stored `serverSpec` back into the editor (anything it does not understand stays in `base`). */
export const specToDraft = (spec: unknown): SpecDraft => {
  const s = rec(spec);
  if (Object.keys(s).length === 0) return defaultSpec();
  const auth = rec(s.auth);
  const secretFields = list(auth.fields).map(rec);
  const authMode = authModeOf(auth);
  const secrets: VariableDraft[] = secretFields.map((f) => ({
    name: str(f.name),
    label: str(f.label),
    required: true,
    secret: true,
    default: '',
  }));
  const plain: VariableDraft[] =
    s.type === 'remote'
      ? Object.entries(rec(s.variables)).map(([name, raw]) => {
          const v = rec(raw);
          return {
            name,
            label: str(v.description),
            required: v.isRequired !== false,
            secret: false,
            default: str(v.default),
          };
        })
      : list(s.environmentVariables)
          .map(rec)
          .filter(isVarInput)
          .map((v) => {
            return {
              name: str(v.name),
              label: str(v.description),
              required: v.isRequired !== false,
              secret: false,
              default: str(v.default),
            };
          });
  const orgInject = rec(list(auth.inject)[0]);
  return {
    type: s.type === 'remote' ? 'remote' : 'package',
    runtime: s.runtime === 'pypi' ? 'pypi' : 'npm',
    identifier: str(s.identifier),
    version: str(s.version),
    transport: s.transport === 'sse' ? 'sse' : 'streamable-http',
    url: str(s.url),
    variables: [...plain, ...(authMode === 'userSecret' ? secrets : [])],
    authMode,
    oauthScopes: list(auth.scopes).map(String),
    orgSecretName: authMode === 'orgSecret' ? str(orgInject.name) : '',
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
  visibility: entry.visibility,
  risk: entry.risk,
  autoUpgrade: entry.autoUpgrade,
  userOverrides: entry.userOverrides,
  onDrift: entry.onDrift,
  label,
  overrides: version?.overrides ?? { version: 1 },
  spec: version?.serverSpec ? specToDraft(version.serverSpec) : defaultSpec(),
});

export { slugify };

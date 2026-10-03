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
import type { Body, DriftPolicy, RiskLevel } from '@/api/schema';
import type { CatalogEntry } from '@/api/views/catalog';

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

/**
 * How Bastion identifies itself to the service behind an OAuth server (9.6). `auto` registers itself when the service
 * allows it. Services that do not (GitHub) need an app registered by hand: its client id and secret go here.
 */
export type OAuthClientDraft = {
  registration: 'auto' | 'preRegistered';
  clientId: string;
  authMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
};

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
  oauthClient: OAuthClientDraft;
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
  oauthClient: { registration: 'auto', clientId: '', authMethod: 'client_secret_basic' },
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

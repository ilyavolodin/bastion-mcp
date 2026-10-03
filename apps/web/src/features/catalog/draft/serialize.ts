import type {
  CatalogEntry,
  CatalogVersion,
  InstallFormBody,
  ServerSpecBody,
} from '@/api/views/catalog';
import { asList, asRecord, asString } from '@/lib/json';
import {
  BEARER_PREFIX,
  oauthClientSecretName,
  oauthTokenTemplate,
  secretNamesOf,
  secretRefsOf,
} from './secrets';
import {
  type ArgDraft,
  type AuthMode,
  type BindingDraft,
  type Draft,
  defaultSpec,
  type EntryCreateBody,
  type EntryPatchBody,
  type OAuthClientDraft,
  type SpecDraft,
  type VariableDraft,
  type VersionCreateBody,
  type Visibility,
} from './types';
import { splitChoices } from './validate';

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

const oauthClientOf = (s: SpecDraft) => {
  const c = s.oauthClient;
  if (c.registration === 'preRegistered') {
    return {
      registration: 'preRegistered' as const,
      clientId: c.clientId.trim(),
      ...(c.authMethod === 'none' ? {} : { clientSecretRef: oauthClientSecretName(c) }),
      authMethod: c.authMethod,
    };
  }
  // A spec imported with a fixed `cimd` or `dcr` choice keeps it.
  const kept = asRecord(asRecord(s.base?.auth).client);
  return kept.registration === 'cimd' || kept.registration === 'dcr'
    ? (kept as { registration: 'cimd' | 'dcr' })
    : { registration: 'auto' as const };
};

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
        client: oauthClientOf(s),
        ...(s.oauthScopes.length ? { scopes: s.oauthScopes } : {}),
        ...(inject.length > 0
          ? { inject }
          : s.type === 'remote'
            ? {
                inject: [
                  {
                    to: 'header' as const,
                    name: 'Authorization',
                    value: `${BEARER_PREFIX}${oauthTokenTemplate()}`,
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
  label: asString(v.label) || asString(v.description),
  description: asString(v.label) ? asString(v.description) : '',
  required: v.required === undefined ? v.isRequired !== false : v.required !== false,
  default: asString(v.default),
  choices: asList(v.choices).map(String).join(', '),
});

/** The install-form variables of a stored version; older versions without a form derive them from the spec. */
const variablesOf = (
  s: Record<string, unknown>,
  form: Record<string, unknown>,
): VariableDraft[] => {
  const fromForm = asList(form.variables)
    .map(asRecord)
    .filter((v) => typeof v.name === 'string')
    .map((v) => variableFrom(v, asString(v.name)));
  if (fromForm.length > 0) return fromForm;
  if (s.type === 'remote')
    return Object.entries(asRecord(s.variables)).map(([name, raw]) =>
      variableFrom(asRecord(raw), name),
    );
  return asList(s.environmentVariables)
    .map(asRecord)
    .filter((e) => typeof e.name === 'string' && e.value === `{{var.${e.name}}}`)
    .map((e) => variableFrom(e, asString(e.name)));
};

const injectedBinding = (r: Record<string, unknown>): BindingDraft => ({
  name: asString(r.name),
  value: asString(r.value),
  secret: true,
});

/** Reads a stored `serverSpec` back into the editor (anything it does not understand stays in `base`). */
export const specToDraft = (spec: unknown, installForm?: unknown): SpecDraft => {
  const s = asRecord(spec);
  if (Object.keys(s).length === 0) return defaultSpec();
  const auth = asRecord(s.auth);
  const authMode = authModeOf(auth);
  const inject = asList(auth.inject).map(asRecord);
  const injectsSecrets = authMode === 'orgSecret' || authMode === 'userSecret';
  const injectsCredential = injectsSecrets || authMode === 'oauth';
  const remote = s.type === 'remote';
  // The default `Authorization: Bearer {{oauth.accessToken}}` of a remote OAuth server is implied, not a row.
  const impliedOauth = (r: Record<string, unknown>) =>
    remote &&
    authMode === 'oauth' &&
    r.to === 'header' &&
    asString(r.name).toLowerCase() === 'authorization' &&
    r.value === `${BEARER_PREFIX}${oauthTokenTemplate()}`;

  const plainBinding = (raw: unknown): BindingDraft => {
    const e = asRecord(raw);
    return {
      name: asString(e.name),
      value: typeof e.value === 'string' ? e.value : asString(e.default),
      secret: false,
      raw: rawRest(e, ['name', 'value']),
    };
  };
  const headers: BindingDraft[] = remote
    ? [
        ...asList(s.headers).map(plainBinding),
        ...(injectsCredential
          ? inject.filter((r) => r.to === 'header' && !impliedOauth(r)).map(injectedBinding)
          : []),
      ]
    : [];
  const injectedEnv = new Set(inject.filter((r) => r.to === 'env').map((r) => asString(r.name)));
  const envVars: BindingDraft[] = remote
    ? []
    : [
        ...asList(s.environmentVariables)
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
        ...asList(s.packageArguments).map((raw) => {
          const a = asRecord(raw);
          return {
            kind: a.type === 'named' ? ('named' as const) : ('positional' as const),
            name: asString(a.name),
            value: asString(a.value),
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
                name: asString(r.flag),
                value: asString(r.value),
                secret: true,
              }))
          : []),
      ];
  const secretLabels = Object.fromEntries(
    asList(auth.fields)
      .map(asRecord)
      .map((f) => [asString(f.name), asString(f.label)] as const)
      .filter(([name, label]) => name !== '' && label !== '' && label !== name),
  );
  return {
    type: remote ? 'remote' : 'package',
    runtime: s.runtime === 'pypi' ? 'pypi' : 'npm',
    identifier: asString(s.identifier),
    version: asString(s.version),
    transport: s.transport === 'sse' ? 'sse' : 'streamable-http',
    url: asString(s.url),
    variables: variablesOf(s, asRecord(installForm)),
    headers,
    envVars,
    args,
    authMode,
    oauthScopes: asList(auth.scopes).map(String),
    oauthClient: oauthClientFrom(asRecord(auth.client)),
    secretLabels,
    secretValues: {},
    egress: asList(asRecord(s.egress).allow).map(String),
    size: s.size === 'medium' || s.size === 'large' ? s.size : 'small',
    base: s,
  };
};

const oauthClientFrom = (client: Record<string, unknown>): OAuthClientDraft => {
  if (client.registration !== 'preRegistered')
    return { registration: 'auto', clientId: '', authMethod: 'client_secret_basic' };
  const method = client.authMethod;
  return {
    registration: 'preRegistered',
    clientId: asString(client.clientId),
    authMethod:
      method === 'client_secret_post' || method === 'none' ? method : 'client_secret_basic',
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
  const doc = asRecord(stored);
  return Object.keys(doc).length === 0 ? { version: 1 } : doc;
};

/**
 * What the Servers and Store screens show, built from the rows of the API. An installation row has no icon, no
 * runtime or sign-in mode (those live in the server spec of its catalog version), and the owner is an id: the screens
 * join them here. Everything derives from the generated schema types.
 */
import { z } from 'zod';
import { letterOf, tintOf } from '@/lib/avatar';
import type { Body, Res, Schemas } from '../schema';

export type Installation = Schemas['Installation'];
export type Endpoint = Schemas['Endpoint'];
export type StoreEntry = Schemas['StoreEntry'];
export type StoreEntryDetail = Schemas['StoreEntryDetail'];
export type Definitions = Res<'get', '/installations/{id}/tools'>;
export type OverridePreview = Schemas['OverridePreview'];
export type EgressEntry = Schemas['EgressEntry'];
export type ClientConfig = Res<'get', '/endpoints/{id}/client-config'>;
export type ClientKind = NonNullable<
  NonNullable<import('../schema').Query<'get', '/endpoints/{id}/client-config'>>['client']
>;
export type TryBody = Body<'post', '/installations/{id}/try'>;
export type TryResult = Res<'post', '/installations/{id}/try'>;
export type OverrideDocument = Body<'put', '/installations/{id}/overrides'>;

// --- what a server spec says (8.1) ------------------------------------------------------------------------------

export type AuthMode =
  | 'none'
  | 'orgSecret'
  | 'userSecret'
  | 'oauth'
  | 'enterpriseManaged'
  | 'tokenExchange';
export type Runtime = 'remote' | 'npm' | 'pypi';

/** The part of a `ServerSpec` the screens read. The spec itself is an open record in the API types. */
export type SpecInfo = {
  runtime: Runtime;
  authMode: AuthMode;
  /** Package identifier (`@acme/pg-mcp`) or the remote URL. */
  target: string;
  /** Exact package version, when the spec has one. */
  version: string | null;
  /** Hosts the server reaches: the egress allowlist of a package, the host of a remote URL. */
  hosts: string[];
  /** OAuth scopes of the upstream sign-in. */
  scopes: string[];
  /** Fields of a `userSecret` sign-in. */
  secretFields: { name: string; label: string }[];
  sandboxed: boolean;
};

const specSchema = z.looseObject({
  type: z.enum(['remote', 'package']),
  url: z.string().optional(),
  runtime: z.enum(['npm', 'pypi']).optional(),
  identifier: z.string().optional(),
  version: z.string().optional(),
  egress: z.looseObject({ allow: z.array(z.string()).optional() }).optional(),
  auth: z
    .looseObject({
      mode: z.string(),
      scopes: z.array(z.string()).optional(),
      fields: z.array(z.looseObject({ name: z.string(), label: z.string() })).optional(),
    })
    .optional(),
});

const AUTH_MODES: readonly string[] = [
  'none',
  'orgSecret',
  'userSecret',
  'oauth',
  'enterpriseManaged',
  'tokenExchange',
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Reads the runtime, sign-in mode and reach of a server spec; `null` for skills and plugins (no spec). */
export const specInfo = (spec: unknown): SpecInfo | null => {
  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) return null;
  const s = parsed.data;
  const mode = s.auth?.mode ?? 'none';
  const isRemote = s.type === 'remote';
  return {
    runtime: isRemote ? 'remote' : (s.runtime ?? 'npm'),
    authMode: (AUTH_MODES.includes(mode) ? mode : 'none') as AuthMode,
    target: isRemote ? (s.url ?? '') : (s.identifier ?? ''),
    version: isRemote ? null : (s.version ?? null),
    hosts: isRemote ? (s.url ? [hostOf(s.url)] : []) : (s.egress?.allow ?? []),
    scopes: s.auth?.scopes ?? [],
    secretFields: (s.auth?.fields ?? []).map((f) => ({ name: f.name, label: f.label })),
    sandboxed: !isRemote,
  };
};

// --- installations ----------------------------------------------------------------------------------------------

export type InstallationView = Installation & {
  letter: string;
  color: string;
  /** Team name, person name, or `You`. */
  ownerName: string;
  runtime: Runtime;
  authMode: AuthMode;
  sandboxed: boolean;
  /** Label of the catalog version it runs, or the package version of a personal install. */
  versionLabel: string | null;
  /** Package identifier, for sandboxed servers. */
  package: string | null;
  spec: SpecInfo | null;
};

export type InstallationLookups = {
  /** Display names of the teams and people, by id. */
  names: ReadonlyMap<string, string>;
  /** The caller: owner of the installations that are theirs. */
  meId: string;
  /** Version label by catalog version id. */
  versionLabels: ReadonlyMap<string, string>;
  /** Parsed spec by catalog version id. */
  specs: ReadonlyMap<string, SpecInfo | null>;
};

export const toInstallationView = (
  row: Installation,
  lookups: InstallationLookups,
): InstallationView => {
  const spec = row.personalSpec
    ? specInfo(row.personalSpec)
    : row.catalogVersionId
      ? (lookups.specs.get(row.catalogVersionId) ?? null)
      : null;
  return {
    ...row,
    letter: letterOf(row.displayName),
    color: tintOf(row.slug),
    ownerName:
      row.ownerType === 'user' && row.ownerId === lookups.meId
        ? 'You'
        : (lookups.names.get(row.ownerId) ?? row.ownerId),
    runtime: spec?.runtime ?? 'remote',
    authMode: spec?.authMode ?? 'none',
    sandboxed: spec?.sandboxed ?? false,
    versionLabel:
      (row.catalogVersionId ? lookups.versionLabels.get(row.catalogVersionId) : undefined) ??
      spec?.version ??
      null,
    package: spec?.sandboxed ? spec.target : null,
    spec,
  };
};

/**
 * The URL an installation answers on by itself (7.1): `/mcp/i/<slug>`. Every URL is built from the server's own public
 * base URL (scheme included), never from a guessed scheme: an evaluation setup runs on `http://localhost`.
 */
export const installationUrl = (baseUrl: string, slug: string): string =>
  `${baseUrl}/mcp/i/${slug}`;

/** The default endpoint carries everything the caller has set up. */
export const defaultEndpointUrl = (baseUrl: string): string => `${baseUrl}/mcp`;

export const endpointUrl = (baseUrl: string, slug: string): string => `${baseUrl}/mcp/e/${slug}`;

/** Names of the secrets an installation already has a value for. */
export const secretsSet = (row: Pick<Installation, 'secretRefs'>): Set<string> =>
  new Set(Object.keys(row.secretRefs));

/** Whether a server needs a secret to be typed in, and which ones are still missing. */
export const secretStatus = (
  row: Pick<Installation, 'secretRefs'>,
  info: Pick<SpecInfo, 'secretFields'> | null,
  formSecrets: readonly { name: string }[] = [],
): { name: string; set: boolean }[] => {
  const set = secretsSet(row);
  const names = new Set<string>([
    ...formSecrets.map((s) => s.name),
    ...(info?.secretFields ?? []).map((f) => f.name),
    ...set,
  ]);
  return [...names].map((name) => ({ name, set: set.has(name) }));
};

// --- endpoints --------------------------------------------------------------------------------------------------

export type EndpointView = Endpoint & {
  /** `displayName` of the row. */
  name: string;
  url: string;
};

export const toEndpointView = (row: Endpoint, host: string): EndpointView => ({
  ...row,
  name: row.displayName,
  url: endpointUrl(host, row.slug),
});

// --- capabilities (7.3) -----------------------------------------------------------------------------------------

export type CapabilityKind = 'tool' | 'prompt' | 'resource' | 'template';

export type CapabilityView = {
  kind: CapabilityKind;
  /** The name, URI or URI template the AI tool sees. */
  name: string;
  description: string;
  /** The item differs from upstream (an override applies). */
  overridden: boolean;
  /** Its name collided with another server's and was prefixed. */
  collided: boolean;
};

const META_KIND: Record<string, CapabilityKind> = {
  tool: 'tool',
  prompt: 'prompt',
  resource: 'resource',
  resourceTemplate: 'template',
};

const keyOfItem = (item: Definitions['items'][number]): string =>
  item.name ?? item.uri ?? item.uriTemplate ?? '';

/** The served items of one kind, marked from the engine's per-item decisions. */
export const toCapabilities = (kind: CapabilityKind, res: Definitions): CapabilityView[] => {
  const metaByKey = new Map(
    res.meta.filter((m) => META_KIND[m.kind] === kind).map((m) => [m.finalKey, m]),
  );
  return res.items.map((item) => {
    const name = keyOfItem(item);
    const meta = metaByKey.get(name);
    return {
      kind,
      name,
      description: item.description ?? item.title ?? '',
      overridden: Boolean(meta?.overridden || meta?.renamed),
      collided: Boolean(meta?.collided),
    };
  });
};

// --- overrides (12.5) -------------------------------------------------------------------------------------------

export type DefinitionPair = {
  name: string;
  kind: CapabilityKind;
  /** The definition as the server lists it; `null` for an item that is hidden (the engine withholds it). */
  upstream: Record<string, unknown> | null;
  /** The definition AI tools see; `null` when hidden or invalid. */
  final: Record<string, unknown> | null;
  hidden: boolean;
  error: string | null;
};

type Change = OverridePreview['diff'][number]['changes'][number];

const decode = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Undoes the changes the engine reports, so that the final definition becomes the upstream one again. */
export const revertChanges = (
  final: Record<string, unknown>,
  changes: readonly Change[],
): Record<string, unknown> => {
  const out = cloneJson(final);
  for (const change of [...changes].reverse()) {
    const segments = change.path.split('/').slice(1).map(decode);
    const last = segments.pop();
    if (last === undefined) continue;
    let cursor: unknown = out;
    for (const s of segments) {
      cursor = (cursor as Record<string, unknown> | undefined)?.[s];
    }
    if (cursor === null || typeof cursor !== 'object') continue;
    const target = cursor as Record<string, unknown> & unknown[];
    if (change.op === 'add') {
      if (Array.isArray(target)) target.splice(Number(last), 1);
      else delete target[last];
    } else {
      target[Array.isArray(target) ? Number(last) : last] = cloneJson(change.before);
    }
  }
  return out;
};

const finalDefinition = (
  preview: OverridePreview,
  kind: OverridePreview['diff'][number]['kind'],
  key: string,
): Record<string, unknown> | null => {
  const f = preview.final;
  switch (kind) {
    case 'tool':
      return f.tools.find((x) => x.upstreamName === key)?.tool ?? null;
    case 'prompt':
      return f.prompts.find((x) => x.upstreamName === key)?.prompt ?? null;
    case 'resource':
      return f.resources.find((x) => x.upstreamUri === key)?.resource ?? null;
    case 'resourceTemplate':
      return f.resourceTemplates.find((x) => x.upstreamTemplate === key)?.template ?? null;
  }
};

/** One pair per upstream item, in the order the engine reported them. */
export const toDefinitionPairs = (preview: OverridePreview): DefinitionPair[] =>
  preview.diff.map((d) => {
    const final = finalDefinition(preview, d.kind, d.key);
    return {
      name: d.key,
      kind: META_KIND[d.kind] ?? 'tool',
      upstream: final ? revertChanges(final, d.changes) : null,
      final,
      hidden: d.status === 'hidden',
      error: d.error ?? (d.status === 'invalid' ? 'invalid override' : null),
    };
  });

/** The section of the override document an item of this kind lives in. */
export const SECTION = {
  tool: 'tools',
  prompt: 'prompts',
  resource: 'resources',
  template: 'resourceTemplates',
} as const;

// --- egress (8.8) -----------------------------------------------------------------------------------------------

export type EgressHost = {
  host: string;
  status: 'allowed' | 'denied';
  reason: string;
  lastSeenAt: string | null;
};

/** Recent egress decisions grouped per host: the latest decision wins. */
export const groupEgress = (entries: readonly EgressEntry[]): EgressHost[] => {
  const byHost = new Map<string, { entry: EgressEntry; count: number }>();
  for (const entry of entries) {
    const seen = byHost.get(entry.host);
    byHost.set(entry.host, {
      entry: !seen || entry.ts >= seen.entry.ts ? entry : seen.entry,
      count: (seen?.count ?? 0) + 1,
    });
  }
  return [...byHost.values()].map(({ entry, count }) => ({
    host: entry.host,
    status: entry.decision === 'allowed' ? 'allowed' : 'denied',
    reason: `${count} recent ${count === 1 ? 'connection' : 'connections'} on port ${entry.port}`,
    lastSeenAt: entry.ts,
  }));
};

// --- the store (11.1) -------------------------------------------------------------------------------------------

export type StoreEntryView = StoreEntry & {
  letter: string;
  color: string;
  /** The caller already has an installation of it. */
  installed: boolean;
  /** Section of the store: the kind of entry. */
  category: string;
};

const KIND_LABEL: Record<StoreEntry['kind'], string> = {
  mcp_server: 'Servers',
  skill: 'Skills',
  plugin: 'Plugins',
  tool: 'Tools',
};

export const toStoreEntryView = (
  row: StoreEntry,
  installedEntryIds: ReadonlySet<string>,
): StoreEntryView => ({
  ...row,
  letter: letterOf(row.displayName),
  color: tintOf(row.slug),
  installed: installedEntryIds.has(row.id),
  category: KIND_LABEL[row.kind],
});

export type InstallFieldDef = {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  /** A fixed list of allowed values: the form shows a picker instead of a text box. */
  choices?: string[];
};

export type StoreEntryDetailView = StoreEntryView &
  Pick<StoreEntryDetail, 'version'> & {
    spec: SpecInfo | null;
    /** What the installer fills in: variables, then secrets. */
    variables: InstallFieldDef[];
    secrets: InstallFieldDef[];
  };

type FormVariable = NonNullable<StoreEntryDetail['version']>['installForm']['variables'][number];
type FormSecret = NonNullable<StoreEntryDetail['version']>['installForm']['secrets'][number];

const variableField = (v: FormVariable): InstallFieldDef => ({
  name: v.name,
  label: v.label ?? v.name,
  ...(v.description ? { help: v.description } : {}),
  required: v.required ?? false,
  secret: false,
  ...(v.default !== undefined ? { default: v.default } : {}),
  ...(v.choices?.length ? { choices: v.choices } : {}),
});

const secretField = (s: FormSecret): InstallFieldDef => ({
  name: s.name,
  label: s.label ?? s.name,
  ...(s.description ? { help: s.description } : {}),
  required: true,
  secret: true,
});

export const toStoreEntryDetailView = (
  row: StoreEntryDetail,
  installedEntryIds: ReadonlySet<string>,
  spec: SpecInfo | null,
): StoreEntryDetailView => ({
  ...toStoreEntryView(row, installedEntryIds),
  version: row.version,
  spec,
  variables: (row.version?.installForm.variables ?? []).map(variableField),
  secrets: (row.version?.installForm.secrets ?? []).map(secretField),
});

/** Whether installing needs a sign-in step afterwards. */
export const needsOauth = (spec: SpecInfo | null): boolean => spec?.authMode === 'oauth';

// --- the install form (11.4) ------------------------------------------------------------------------------------

export type InstallValues = {
  /** `user` or the id of a team the caller may install for. */
  owner: string;
  slug: string;
  pinnedVersion: boolean;
  fields: Record<string, string>;
};

/** The body of `POST /installations` for an entry of the store. */
export const toInstallBody = (
  entry: Pick<StoreEntryDetailView, 'id' | 'version' | 'variables'>,
  values: InstallValues,
): Body<'post', '/installations'> => ({
  catalogEntryId: entry.id,
  ...(entry.version ? { catalogVersionId: entry.version.id } : {}),
  ownerType: values.owner === 'user' ? 'user' : 'team',
  ...(values.owner === 'user' ? {} : { teamId: values.owner }),
  slug: values.slug,
  variables: Object.fromEntries(
    entry.variables.map((v) => [v.name, values.fields[v.name] ?? '']).filter(([, v]) => v !== ''),
  ),
  pinnedVersion: values.pinnedVersion,
});

// --- endpoint form -----------------------------------------------------------------------------------------------

export type EndpointValues = {
  displayName: string;
  slug: string;
  installationIds: string[];
  prefixMode: Endpoint['prefixMode'];
  instructions: string;
};

export const toEndpointBody = (values: EndpointValues): Body<'post', '/endpoints'> => ({
  slug: values.slug,
  displayName: values.displayName.trim(),
  installationIds: values.installationIds,
  prefixMode: values.prefixMode,
  ...(values.instructions.trim() ? { instructions: values.instructions.trim() } : {}),
});

export const toEndpointPatch = (values: EndpointValues): Body<'patch', '/endpoints/{id}'> => ({
  slug: values.slug,
  displayName: values.displayName.trim(),
  installationIds: values.installationIds,
  prefixMode: values.prefixMode,
  instructions: values.instructions.trim() ? values.instructions.trim() : null,
});

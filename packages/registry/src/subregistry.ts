import { metaKey, paginate, sha256Hex } from '@bastion-mcp/core';
import { REGISTRY_OFFICIAL_META } from './server-json';

/**
 * Bastion as a subregistry (11.8). Pure functions that turn the caller's endpoints and installations into
 * `/registry/v0.1/*` responses; the api layer authenticates (`api:read`) and loads the caller's data.
 */

export const SUBREGISTRY_META_KEY = metaKey('registry');
export const SERVER_JSON_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const DEFAULT_ENDPOINT_NAME = '_default';
export const DEFAULT_SUBREGISTRY_PAGE_SIZE = 30;
export const MAX_SUBREGISTRY_PAGE_SIZE = 100;
const DEFAULT_VERSION = '1.0.0';

export type SubregistryInstallation = {
  installationId: string;
  slug: string;
  displayName: string;
  description?: string;
  catalogEntryId?: string;
  /** Catalog version shown as the registry version; `1.0.0` when unknown. */
  version?: string;
  createdAt?: Date;
  updatedAt?: Date;
  enabled?: boolean;
};

export type SubregistryInput = {
  /** Public host (with optional port) of this Bastion deployment, for example `bastion.acme.com`. */
  host: string;
  installations: readonly SubregistryInstallation[];
  /** Default `https`. */
  scheme?: 'https' | 'http';
  /** Name shown for the default endpoint. */
  defaultEndpointTitle?: string;
  updatedAt?: Date;
};

export type SubregistryServer = {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  remotes: { type: 'streamable-http'; url: string }[];
  _meta: Record<string, unknown>;
};

export type SubregistryEntry = {
  server: SubregistryServer;
  _meta: Record<string, unknown>;
};

export type SubregistryList = {
  servers: SubregistryEntry[];
  metadata: { nextCursor?: string; count: number };
};

/** `bastion.acme.com:8443` becomes `com.acme.bastion`: reverse-DNS form, port dropped (11.8). */
export const registryNamespaceFromHost = (host: string): string => {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  const labels = bare.split('.').filter((l) => l.length > 0);
  const cleaned = labels
    .reverse()
    .map((l) => l.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''))
    .filter((l) => l.length > 0);
  return cleaned.length > 0 ? cleaned.join('.') : 'localhost';
};

const endpointOrigin = (input: SubregistryInput): string =>
  `${input.scheme ?? 'https'}://${input.host
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')}`;

const toEntry = (
  input: SubregistryInput,
  spec: {
    name: string;
    title: string;
    description: string;
    version: string;
    url: string;
    kind: 'default' | 'installation';
    slug: string | null;
    installationId?: string;
    catalogEntryId?: string;
    createdAt: Date | undefined;
    updatedAt: Date | undefined;
    enabled: boolean;
  },
): SubregistryEntry => {
  const meta = {
    kind: spec.kind,
    slug: spec.slug,
    endpointUrl: spec.url,
    ...(spec.installationId ? { installationId: spec.installationId } : {}),
    ...(spec.catalogEntryId ? { catalogEntryId: spec.catalogEntryId } : {}),
    enabled: spec.enabled,
  };
  const published = (spec.createdAt ?? input.updatedAt ?? new Date(0)).toISOString();
  const updated = (spec.updatedAt ?? input.updatedAt ?? new Date(0)).toISOString();
  return {
    server: {
      $schema: SERVER_JSON_SCHEMA_URL,
      name: spec.name,
      title: spec.title,
      description: spec.description,
      version: spec.version,
      remotes: [{ type: 'streamable-http', url: spec.url }],
      _meta: { [SUBREGISTRY_META_KEY]: meta },
    },
    _meta: {
      [REGISTRY_OFFICIAL_META]: {
        status: 'active',
        publishedAt: published,
        updatedAt: updated,
        isLatest: true,
      },
      [SUBREGISTRY_META_KEY]: meta,
    },
  };
};

/**
 * One entry for the default endpoint at `/mcp` and one per installation at `/mcp/i/<slug>` (11.8).
 * Order is stable: the default first, then installations by slug.
 */
export const buildSubregistryEntries = (input: SubregistryInput): SubregistryEntry[] => {
  const namespace = registryNamespaceFromHost(input.host);
  const origin = endpointOrigin(input);
  const entries: SubregistryEntry[] = [
    toEntry(input, {
      name: `${namespace}/${DEFAULT_ENDPOINT_NAME}`,
      title: input.defaultEndpointTitle ?? 'Bastion default endpoint',
      description: 'All servers installed for you, behind one MCP endpoint.',
      version: DEFAULT_VERSION,
      url: `${origin}/mcp`,
      kind: 'default',
      slug: null,
      createdAt: undefined,
      updatedAt: input.updatedAt,
      enabled: true,
    }),
  ];
  const sorted = [...input.installations].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const inst of sorted) {
    entries.push(
      toEntry(input, {
        name: `${namespace}/${inst.slug}`,
        title: inst.displayName,
        description: inst.description ?? inst.displayName,
        version: inst.version ?? DEFAULT_VERSION,
        url: `${origin}/mcp/i/${inst.slug}`,
        kind: 'installation',
        slug: inst.slug,
        installationId: inst.installationId,
        ...(inst.catalogEntryId ? { catalogEntryId: inst.catalogEntryId } : {}),
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
        enabled: inst.enabled ?? true,
      }),
    );
  }
  return entries;
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** `GET /registry/v0.1/servers` with opaque cursors and optional `search` (11.8). */
export const listSubregistryServers = (
  input: SubregistryInput,
  query: { limit?: number; cursor?: string | undefined; search?: string | undefined } = {},
): SubregistryList => {
  const needle = query.search?.trim().toLowerCase();
  const all = buildSubregistryEntries(input).filter(
    (e) =>
      !needle ||
      e.server.name.toLowerCase().includes(needle) ||
      e.server.title.toLowerCase().includes(needle) ||
      e.server.description.toLowerCase().includes(needle),
  );
  const pageSize = Math.min(
    Math.max(1, Math.trunc(query.limit ?? DEFAULT_SUBREGISTRY_PAGE_SIZE)),
    MAX_SUBREGISTRY_PAGE_SIZE,
  );
  // The cursor is bound to the visible set, so one from a different caller restarts at the top.
  const endpointHash = sha256Hex(`${needle ?? ''}|${all.map((e) => e.server.name).join(',')}`);
  const page = paginate(all, { pageSize, endpointHash, cursor: query.cursor });
  return {
    servers: page.items,
    metadata: {
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      count: page.items.length,
    },
  };
};

const findByName = (input: SubregistryInput, name: string): SubregistryEntry | undefined => {
  const wanted = safeDecode(name).toLowerCase();
  return buildSubregistryEntries(input).find((e) => e.server.name.toLowerCase() === wanted);
};

/** `GET /registry/v0.1/servers/{name}/versions`; null means 404. */
export const getSubregistryVersions = (
  input: SubregistryInput,
  name: string,
): SubregistryList | null => {
  const entry = findByName(input, name);
  return entry ? { servers: [entry], metadata: { count: 1 } } : null;
};

/** `GET /registry/v0.1/servers/{name}/versions/{version}`; `latest` is accepted; null means 404. */
export const getSubregistryVersion = (
  input: SubregistryInput,
  name: string,
  version: string,
): SubregistryEntry | null => {
  const entry = findByName(input, name);
  if (!entry) return null;
  const wanted = safeDecode(version);
  return wanted === 'latest' || wanted === entry.server.version ? entry : null;
};

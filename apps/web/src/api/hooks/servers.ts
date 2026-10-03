import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { FAN_OUT, mapInBatches } from '../batch';
import { api, fetchAll, LOOKUP_PAGES } from '../client';
import type { Body } from '../schema';
import { STALE_LOOKUP_MS } from '../timing';
import {
  type CapabilityKind,
  type CapabilityView,
  type ClientKind,
  type EndpointView,
  groupEgress,
  type InstallationView,
  specInfo,
  toCapabilities,
  toEndpointView,
  toInstallationView,
  toStoreEntryDetailView,
  toStoreEntryView,
} from '../views/servers';
import { keys, useApiMutation } from './base';
import { fetchTeams, orEmpty } from './lookups';
import { useMe } from './session';

// --- Installations ------------------------------------------------------------------------------

/**
 * The caller's installations with owner names and what their server specs say (runtime, sign-in mode). The rows carry
 * only ids, so this reads the teams and people and the catalog versions of the installations, a bounded fan-out.
 */
export const useInstallations = () => {
  const me = useMe();
  return useQuery({
    queryKey: [...keys.installations, me.data?.id ?? ''],
    enabled: me.isSuccess,
    queryFn: async ({ signal }): Promise<InstallationView[]> => {
      const rows = await fetchAll('/installations', undefined, undefined, signal);
      const [teams, users] = await Promise.all([
        orEmpty(fetchTeams(signal)),
        orEmpty(fetchAll('/users', undefined, LOOKUP_PAGES, signal)),
      ]);
      const names = new Map<string, string>([
        ...users.map((u) => [u.id, u.displayName] as const),
        ...teams.map((t) => [t.id, t.displayName] as const),
      ]);
      // The version an installation runs is the entry's newest published one unless it is pinned: ask the entries.
      const entryIds = [
        ...new Set(rows.flatMap((r) => (r.catalogEntryId ? [r.catalogEntryId] : []))),
      ];
      const currentOf = new Map<string, string | null>();
      await mapInBatches(entryIds, FAN_OUT, async (id) => {
        const entry = await api.get(`/catalog/${id}`, { signal }).catch(() => null);
        currentOf.set(id, entry?.currentVersionId ?? null);
      });
      const versions = new Map<string, { running: string | null; latest: string | null }>();
      for (const r of rows) {
        if (!r.catalogEntryId) continue;
        const latest = currentOf.get(r.catalogEntryId) ?? null;
        versions.set(r.id, {
          running: r.pinnedVersion ? r.catalogVersionId : (latest ?? r.catalogVersionId),
          latest,
        });
      }
      const wanted = [
        ...new Map(
          [...versions.entries()].flatMap(([id, v]) => {
            const row = rows.find((r) => r.id === id);
            return [v.running, v.latest]
              .filter((versionId): versionId is string => versionId !== null)
              .map((versionId) => [versionId, row?.catalogEntryId ?? ''] as const);
          }),
        ).entries(),
      ];
      const versionLabels = new Map<string, string>();
      const specs = new Map<string, ReturnType<typeof specInfo>>();
      await mapInBatches(wanted, FAN_OUT, async ([versionId, entryId]) => {
        const v = await api
          .get(`/catalog/${entryId}/versions/${versionId}`, { signal })
          .catch(() => null);
        if (v) {
          versionLabels.set(v.id, v.label);
          specs.set(v.id, specInfo(v.serverSpec));
        }
      });
      const lookups = { names, meId: me.data?.id ?? '', versionLabels, specs, versions };
      return rows.map((r) => toInstallationView(r, lookups));
    },
  });
};

export const useInstallation = (id: string) => {
  const installations = useInstallations();
  return useQuery({
    queryKey: keys.installation(id),
    enabled: installations.isSuccess,
    queryFn: async ({ signal }): Promise<InstallationView> => {
      // The detail read also remembers the row's ETag for the PATCH that follows (17.1).
      const row = await api.get(`/installations/${id}`, { signal });
      const known = installations.data?.find((i) => i.id === id);
      return known ? { ...known, ...row } : toInstallationView(row, emptyLookups());
    },
  });
};

const emptyLookups = () => ({
  names: new Map<string, string>(),
  meId: '',
  versionLabels: new Map<string, string>(),
  specs: new Map<string, ReturnType<typeof specInfo>>(),
});

export const useCreateInstallation = () =>
  useApiMutation(
    (body: Body<'post', '/installations'>) => api.post('/installations', body),
    [keys.installations, keys.store, keys.endpoints],
  );

export const usePatchInstallation = (id: string) =>
  useApiMutation(
    (patch: Body<'patch', '/installations/{id}'>) => api.patch(`/installations/${id}`, patch),
    [keys.installations, keys.installation(id), keys.endpoints],
  );

/**
 * `onDeleted` runs as soon as the server answers, BEFORE the lists refresh: refreshing `['installations']` also
 * re-reads the page of the row that is gone (a 404), so the screen must have left that page by then.
 */
export const useDeleteInstallation = (onDeleted?: (id: string) => void | Promise<void>) =>
  useApiMutation(
    async (id: string) => {
      await api.delete(`/installations/${id}`);
      await onDeleted?.(id);
    },
    [keys.installations, keys.store, keys.endpoints],
  );

export const useRestartInstallation = (id: string) =>
  useApiMutation(() => api.post(`/installations/${id}/restart`), [keys.installation(id)]);

/** Starts the upstream sign-in: the answer is the authorization URL the browser goes to (11.5). */
export const useConnectInstallation = () =>
  useApiMutation(
    (input: { id: string; returnTo?: string }) =>
      api.post(
        `/installations/${input.id}/connect`,
        input.returnTo ? { returnTo: input.returnTo } : {},
      ),
    [keys.installations],
  );

export const useDisconnectInstallation = (id: string) =>
  useApiMutation(
    () => api.delete(`/installations/${id}/connection`),
    [keys.installations, keys.installation(id)],
  );

export const useSetSecret = (id: string) =>
  useApiMutation(
    (input: { name: string; value: string }) =>
      // Setting a secret replaces it: no ETag of the installation is at hand, `*` is "whatever is there".
      api.put(
        `/installations/${id}/secrets/${encodeURIComponent(input.name)}`,
        { value: input.value },
        { etag: '*' },
      ),
    [keys.installations, keys.installation(id)],
  );

// --- capabilities, egress, overrides, try -----------------------------------------------------------

const CAPABILITY_PATHS = [
  ['tool', 'tools'],
  ['prompt', 'prompts'],
  ['resource', 'resources'],
  ['template', 'templates'],
] as const satisfies readonly (readonly [CapabilityKind, string])[];

/** Everything an installation serves after overrides: tools, prompts, resources and templates. */
export const loadCapabilities = async (
  id: string,
  signal?: AbortSignal,
): Promise<CapabilityView[]> => {
  const opts = signal ? { signal } : undefined;
  const [tools, prompts, resources, templates] = await Promise.all([
    api.get(`/installations/${id}/tools`, opts),
    api.get(`/installations/${id}/prompts`, opts),
    api.get(`/installations/${id}/resources`, opts),
    api.get(`/installations/${id}/templates`, opts),
  ]);
  const parts = { tool: tools, prompt: prompts, resource: resources, template: templates };
  return CAPABILITY_PATHS.flatMap(([kind]) => toCapabilities(kind, parts[kind]));
};

export const useCapabilities = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'capabilities'],
    queryFn: ({ signal }) => loadCapabilities(id, signal),
  });

/** How many tools each installation serves, for the endpoint tool-count warning (7.4). */
export const useToolCounts = (ids: readonly string[]): Map<string, number> => {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: [...keys.installation(id), 'tool-count'],
      staleTime: STALE_LOOKUP_MS,
      retry: false,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(`/installations/${id}/tools`, { signal }).then((r) => r.items.length),
    })),
  });
  return new Map(
    ids.flatMap((id, i) => {
      const n = results[i]?.data;
      return n === undefined ? [] : [[id, n] as const];
    }),
  );
};

export const useEgress = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'egress'],
    queryFn: ({ signal }) =>
      api.get(`/installations/${id}/egress`, { signal }).then((r) => groupEgress(r.items)),
  });

export const useOverrides = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'overrides'],
    queryFn: ({ signal }) => api.get(`/installations/${id}/overrides`, { signal }),
  });

export const useSaveOverrides = (id: string) =>
  useApiMutation(
    (document: Body<'put', '/installations/{id}/overrides'>) =>
      api.put(`/installations/${id}/overrides`, document),
    [
      [...keys.installation(id), 'overrides'],
      [...keys.installation(id), 'capabilities'],
    ],
  );

export const usePreviewOverrides = () =>
  useApiMutation(
    (input: {
      installationId: string;
      document: Body<'post', '/overrides/preview'>['doc'];
      /** `catalog` previews what every installation of the entry gets; the default is this installation's own. */
      layer?: 'catalog' | 'installation';
    }) =>
      api.post('/overrides/preview', {
        doc: input.document,
        layer: input.layer ?? 'installation',
        installationId: input.installationId,
      }),
  );

/** The overrides every installation of a catalog entry gets (set by an Admin or the entry's owner). */
export const useEntryOverrides = (entryId: string) =>
  useQuery({
    queryKey: ['catalog', entryId, 'default-overrides'],
    queryFn: ({ signal }) => api.get(`/catalog/${entryId}/default-overrides`, { signal }),
  });

export const useSaveEntryOverrides = (entryId: string, installationId: string) =>
  useApiMutation(
    (document: Body<'put', '/catalog/{id}/default-overrides'>) =>
      api.put(`/catalog/${entryId}/default-overrides`, document),
    [
      ['catalog', entryId, 'default-overrides'],
      [...keys.installation(installationId), 'overrides'],
      [...keys.installation(installationId), 'capabilities'],
    ],
  );

/**
 * `POST /installations/{id}/try` (12.5): calls a tool, gets a prompt or reads a resource through the final
 * definitions and the whole pipeline, as the signed-in person.
 */
export const useTry = (id: string) =>
  useApiMutation((input: Body<'post', '/installations/{id}/try'>) =>
    api.post(`/installations/${id}/try`, input),
  );

// --- Endpoints ----------------------------------------------------------------------------------

export const useEndpoints = () => {
  const me = useMe();
  return useQuery({
    queryKey: [...keys.endpoints, me.data?.org.baseUrl ?? ''],
    enabled: me.isSuccess,
    queryFn: async ({ signal }): Promise<EndpointView[]> =>
      (await fetchAll('/endpoints', undefined, undefined, signal)).map((e) =>
        toEndpointView(e, me.data?.org.baseUrl ?? ''),
      ),
  });
};

export const useCreateEndpoint = () =>
  useApiMutation(
    (body: Body<'post', '/endpoints'>) => api.post('/endpoints', body),
    [keys.endpoints],
  );

/** The ETag of a row is its `updatedAt` (17.1); an endpoint list does not remember it, so the caller names it. */
const etagOfRow = (updatedAt: string) => `"${updatedAt}"`;

export const usePatchEndpoint = (id: string) =>
  useApiMutation(
    (input: { patch: Body<'patch', '/endpoints/{id}'>; updatedAt: string }) =>
      api.patch(`/endpoints/${id}`, input.patch, { etag: etagOfRow(input.updatedAt) }),
    [keys.endpoints],
  );

export const useDeleteEndpoint = () =>
  useApiMutation(
    (input: { id: string; updatedAt: string }) =>
      api.delete(`/endpoints/${input.id}`, { etag: etagOfRow(input.updatedAt) }),
    [keys.endpoints],
  );

/**
 * Configuration to paste into an MCP client. With an endpoint id it is that named endpoint's; without one it is the
 * default endpoint's (`/mcp`), which has no row of its own.
 */
export const useClientConfig = (endpointId: string | undefined, client: ClientKind) =>
  useQuery({
    queryKey: [...keys.endpoints, endpointId ?? 'default', 'client-config', client],
    queryFn: ({ signal }) =>
      endpointId
        ? api.get(`/endpoints/${endpointId}/client-config`, { query: { client }, signal })
        : api.get('/client-config', { query: { client }, signal }),
  });

// --- Store --------------------------------------------------------------------------------------

/** The ids of the catalog entries the caller already installed. */
const installedEntryIds = async (signal: AbortSignal): Promise<Set<string>> =>
  new Set(
    (await orEmpty(fetchAll('/installations', undefined, LOOKUP_PAGES, signal)))
      .map((i) => i.catalogEntryId)
      .filter((id): id is string => id !== null),
  );

export const useStore = (q: string) =>
  useQuery({
    queryKey: [...keys.store, 'list', q],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const [rows, installed] = await Promise.all([
        // Skills and plugins reach AI tools through marketplaces, not installations: the store lists servers.
        fetchAll('/store', { kind: 'mcp_server', ...(q ? { q } : {}) }, undefined, signal),
        installedEntryIds(signal),
      ]);
      return rows.map((r) => toStoreEntryView(r, installed));
    },
  });

/** One store entry with what the installer needs; the server spec comes from its current version. */
export const useStoreEntry = (slug: string | null) =>
  useQuery({
    queryKey: [...keys.store, 'entry', slug],
    enabled: Boolean(slug),
    queryFn: async ({ signal }) => {
      const [row, installed] = await Promise.all([
        api.get(`/store/${slug ?? ''}`, { signal }),
        installedEntryIds(signal),
      ]);
      const version = row.version
        ? await api
            .get(`/catalog/${row.id}/versions/${row.version.id}`, { signal })
            .catch(() => null)
        : null;
      return toStoreEntryDetailView(row, installed, version ? specInfo(version.serverSpec) : null);
    },
  });

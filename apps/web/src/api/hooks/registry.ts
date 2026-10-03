import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { api, fetchAll, LOOKUP_PAGES } from '../client';
import type { Body } from '../schema';
import { POLL_REGISTRY_SYNC_MS, REGISTRY_SYNC_TIMEOUT_MS } from '../timing';
import {
  isSyncing,
  NO_SYNC_REQUESTS,
  pruneSyncRequests,
  type RegistryServerView,
  type RegistrySource,
  type RequesterRef,
  type SyncRequests,
  toRequestView,
  toServerView,
  withSyncRequested,
  withVisibility,
} from '../views/registry';
import { useUsers } from './access';
import { keys, pagedQuery, useApiMutation } from './base';
import { useMe } from './session';

/** Source names by id. The source list is readable by everyone who can see the org; a failure only costs the names. */
const useSourceNames = (enabled = true) =>
  useQuery({
    queryKey: [...keys.registry, 'sources'],
    enabled,
    queryFn: async ({ signal }): Promise<Map<string, string>> =>
      new Map(
        (await fetchAll('/registry-sources', undefined, LOOKUP_PAGES, signal)).map((s) => [
          s.id,
          s.name,
        ]),
      ),
    retry: false,
  });

const STATUS_FILTER = { open: { status: 'open' }, all: undefined } as const;

/** Install requests the caller may see (all of them for admins, their teams' for managers, their own otherwise). */
export const useInstallRequests = (status: 'open' | 'all' = 'open', enabled = true) => {
  const users = useUsers({}, enabled);
  const sources = useSourceNames(enabled);
  const requesters = new Map<string, RequesterRef>(
    (users.data ?? []).map((u) => [u.id, { name: u.name, teams: u.teams.map((t) => t.name) }]),
  );
  return useQuery({
    ...pagedQuery(keys.requests, '/install-requests', STATUS_FILTER[status]),
    enabled,
    select: (rows) =>
      rows.map((r) => toRequestView(r, { requesters, sourceNames: sources.data ?? new Map() })),
  });
};

/** Servers per page: the browse screen never loads the whole registry (it has thousands of entries). */
export const REGISTRY_PAGE_SIZE = 24;

export type RegistryFilters = {
  q?: string;
  sourceId?: string;
  runtime?: 'remote' | 'npm' | 'pypi';
};

/**
 * One page of registry servers at a time (server-side search, source and runtime filters; the API lists the newest
 * version of each server of enabled sources only). A changed filter starts again at the first page.
 */
export const useRegistryServers = (filters: RegistryFilters) => {
  const sources = useSourceNames();
  const me = useMe();
  const requests = useQuery({
    ...pagedQuery(keys.requests, '/install-requests', { status: 'open' }),
    retry: false,
  });
  return useInfiniteQuery({
    queryKey: [...keys.registry, 'servers', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/registry/servers', {
        signal,
        query: {
          limit: REGISTRY_PAGE_SIZE,
          cursor: pageParam,
          q: filters.q || null,
          sourceId: filters.sourceId || null,
          runtime: filters.runtime ?? null,
        },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data): { servers: RegistryServerView[]; pages: number } => ({
      pages: data.pages.length,
      servers: data.pages.flatMap((page) =>
        page.items.map((s) =>
          toServerView(s, {
            sourceNames: sources.data ?? new Map(),
            openRequests: requests.data ?? [],
            meId: me.data?.id ?? '',
          }),
        ),
      ),
    }),
  });
};

/**
 * Which syncs the user asked for, and when. Kept in the query cache, not in a module variable, so every screen of the
 * session sees it and a new session (a new client) starts empty.
 */
export const useSyncRequests = (): SyncRequests => {
  const qc = useQueryClient();
  return useQuery<SyncRequests>({
    queryKey: keys.syncRequests,
    queryFn: () => qc.getQueryData<SyncRequests>(keys.syncRequests) ?? NO_SYNC_REQUESTS,
    initialData: NO_SYNC_REQUESTS,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  }).data;
};

/** Remembers that the sync of a source was just asked for, until the source reports a result newer than the click. */
export const useMarkSyncRequested = () => {
  const qc = useQueryClient();
  return React.useCallback(
    (sourceId: string) =>
      qc.setQueryData<SyncRequests>(keys.syncRequests, (prev) =>
        withSyncRequested(prev ?? NO_SYNC_REQUESTS, sourceId, Date.now()),
      ),
    [qc],
  );
};

/**
 * Whether a source is syncing, for rendering. The clock is state: it moves when the requests or the sources change
 * and when the oldest request times out, where the requests that are over are also forgotten.
 */
export const useIsSyncing = (
  sources: readonly Pick<RegistrySource, 'id' | 'lastSync'>[] | undefined,
): ((source: Pick<RegistrySource, 'id' | 'lastSync'>) => boolean) => {
  const qc = useQueryClient();
  const requested = useSyncRequests();
  const [now, setNow] = React.useState(() => Date.now());
  const [tick, setTick] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the effect when the oldest request times out
  React.useEffect(() => {
    if (requested.size === 0) return;
    const current = Date.now();
    setNow(current);
    const pruned = pruneSyncRequests(sources ?? [], requested, current);
    if (pruned !== requested) {
      qc.setQueryData(keys.syncRequests, pruned);
      return;
    }
    const oldest = Math.min(...requested.values());
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      oldest + REGISTRY_SYNC_TIMEOUT_MS - current + 1,
    );
    return () => clearTimeout(timer);
  }, [qc, requested, sources, tick]);
  return (source) => isSyncing(source, requested, now);
};

/** Registry sources with their last sync; refreshes while a sync is running. */
export const useRegistrySources = (enabled = true) => {
  const qc = useQueryClient();
  return useQuery({
    ...pagedQuery([...keys.registry, 'source-list'], '/registry-sources'),
    enabled,
    refetchInterval: (query) => {
      const requested = qc.getQueryData<SyncRequests>(keys.syncRequests) ?? NO_SYNC_REQUESTS;
      const now = Date.now();
      return (query.state.data ?? []).some((s) => isSyncing(s, requested, now))
        ? POLL_REGISTRY_SYNC_MS
        : false;
    },
  });
};

export const useCreateRegistrySource = () =>
  useApiMutation(
    (input: Body<'post', '/registry-sources'>) => api.post('/registry-sources', input),
    [keys.registry],
  );

export const usePatchRegistrySource = () =>
  useApiMutation(
    (input: { id: string; version: string; body: Body<'patch', '/registry-sources/{id}'> }) =>
      api.patch(`/registry-sources/${input.id}`, input.body, { etag: input.version }),
    [keys.registry],
  );

export const useDeleteRegistrySource = () =>
  useApiMutation(
    (input: { id: string; version: string }) =>
      api.delete(`/registry-sources/${input.id}`, { etag: input.version }),
    [keys.registry],
  );

/** Starts a sync; the API answers at once and the walk runs in the background (see `isSyncing`). */
export const useSyncRegistrySource = () =>
  useApiMutation(
    (input: { id: string; full?: boolean }) =>
      api.post(`/registry-sources/${input.id}/sync`, { full: input.full ?? false }),
    [keys.registry],
  );

export const useRegistryPolicy = (sourceId: string, enabled = true) =>
  useQuery({
    queryKey: [...keys.registry, 'policy', sourceId],
    enabled,
    queryFn: ({ signal }) => api.get(`/registry-sources/${sourceId}/policy`, { signal }),
  });

export const usePutRegistryPolicy = () =>
  useApiMutation(
    (input: { sourceId: string; body: Body<'put', '/registry-sources/{id}/policy'> }) =>
      api.put(`/registry-sources/${input.sourceId}/policy`, input.body),
    [keys.registry],
  );

/**
 * Shows or hides one server from members by editing the namespace lists of its source's policy (`withVisibility`).
 * The policy is read first, so its version is the one sent back in `If-Match` (17.1).
 */
export const useSetServerVisibility = () =>
  useApiMutation(
    async (input: { sourceId: string; name: string; show: boolean }) => {
      const current = await api.get(`/registry-sources/${input.sourceId}/policy`);
      return api.put(
        `/registry-sources/${input.sourceId}/policy`,
        withVisibility(current.policy, input.name, input.show),
      );
    },
    [keys.registry],
  );

/**
 * Installs a registry server according to the source policy. The answer is `installed` (201) or `needs-request`
 * (202: the caller sends an install request instead); a denying policy is a 403 problem with the reasons.
 */
export const useRegistryInstall = () =>
  useApiMutation(
    (input: Body<'post', '/registry/install'>) => api.post('/registry/install', input),
    [keys.registry, keys.installations, keys.requests],
  );

export const useCreateInstallRequest = () =>
  useApiMutation(
    (input: Body<'post', '/install-requests'>) => api.post('/install-requests', input),
    [keys.requests, keys.registry],
  );

export const useApproveRequest = () =>
  useApiMutation(
    (id: string) => api.post(`/install-requests/${id}/approve`),
    [keys.requests, keys.installations],
  );

export const useRejectRequest = () =>
  useApiMutation(
    (input: { id: string; body: Body<'post', '/install-requests/{id}/reject'> }) =>
      api.post(`/install-requests/${input.id}/reject`, input.body),
    [keys.requests],
  );

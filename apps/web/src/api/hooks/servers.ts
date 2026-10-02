import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { legacyApi as api } from '../client';
import type {
  ClientConfig,
  ClientId,
  ConnectResult,
  EffectiveCapability,
  EgressEntry,
  EgressHost,
  Endpoint,
  EndpointInput,
  Installation,
  InstallationInput,
  InstallationPatch,
  OverrideDocument,
  OverridePreview,
  StoreEntry,
  StoreEntryDetail,
  TryResult,
} from '../types';
import { keys, listQuery, useApiMutation } from './base';
// --- Installations ------------------------------------------------------------------------------
export const useInstallations = () =>
  useQuery(listQuery<Installation>(keys.installations, '/installations'));

export const useInstallation = (id: string) =>
  useQuery({
    queryKey: keys.installation(id),
    queryFn: ({ signal }) => api.get<Installation>(`/installations/${id}`, { signal }),
  });

export const useCreateInstallation = () =>
  useApiMutation(
    (input: InstallationInput) => api.post<Installation>('/installations', input),
    [keys.installations, keys.store, keys.endpoints],
  );

export const usePatchInstallation = (id: string) =>
  useApiMutation(
    (patch: InstallationPatch) => api.patch<Installation>(`/installations/${id}`, patch),
    [keys.installations, keys.endpoints],
  );

export const useDeleteInstallation = () =>
  useApiMutation(
    (id: string) => api.delete(`/installations/${id}`),
    [keys.installations, keys.store, keys.endpoints],
  );

export const useRestartInstallation = (id: string) =>
  useApiMutation(() => api.post<void>(`/installations/${id}/restart`), [keys.installation(id)]);

export const useConnectInstallation = () =>
  useApiMutation(
    (id: string) => api.post<ConnectResult>(`/installations/${id}/connect`),
    [keys.installations],
  );

export const useDisconnectInstallation = (id: string) =>
  useApiMutation(() => api.delete(`/installations/${id}/connection`), [keys.installations]);

export const useSetSecret = (id: string) =>
  useApiMutation(
    (input: { name: string; value: string }) =>
      api.put<void>(`/installations/${id}/secrets/${encodeURIComponent(input.name)}`, {
        value: input.value,
      }),
    [keys.installations],
  );

const CAPABILITY_PATHS = ['tools', 'prompts', 'resources', 'templates'] as const;
export const useCapabilities = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'capabilities'],
    queryFn: async ({ signal }) => {
      const parts = await Promise.all(
        CAPABILITY_PATHS.map((p) =>
          api.get<{ items: EffectiveCapability[] }>(`/installations/${id}/${p}`, { signal }),
        ),
      );
      return parts.flatMap((p) => p.items);
    },
  });

/** Recent egress decisions grouped per host: the latest decision wins (8.8). */
export const groupEgress = (entries: EgressEntry[]): EgressHost[] => {
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

export const useEgress = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'egress'],
    queryFn: ({ signal }) =>
      api
        .get<{ items: EgressEntry[] }>(`/installations/${id}/egress`, { signal })
        .then((r) => groupEgress(r.items)),
  });

export const useOverrides = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'overrides'],
    queryFn: ({ signal }) =>
      api.get<{ document: OverrideDocument; layer: 'installation'; canEdit: boolean }>(
        `/installations/${id}/overrides`,
        { signal },
      ),
  });

export const useSaveOverrides = (id: string) =>
  useApiMutation(
    (document: OverrideDocument) => api.put<void>(`/installations/${id}/overrides`, document),
    [
      [...keys.installation(id), 'overrides'],
      [...keys.installation(id), 'capabilities'],
    ],
  );

export const usePreviewOverrides = () =>
  useApiMutation((input: { installationId: string; document: OverrideDocument }) =>
    api.post<OverridePreview>('/overrides/preview', input),
  );

export const useTryTool = (id: string) =>
  useApiMutation((input: { name: string; arguments: Record<string, unknown> }) =>
    api.post<TryResult>(`/installations/${id}/try`, input),
  );

// --- Endpoints ----------------------------------------------------------------------------------
export const useEndpoints = () => useQuery(listQuery<Endpoint>(keys.endpoints, '/endpoints'));

export const useCreateEndpoint = () =>
  useApiMutation(
    (input: EndpointInput) => api.post<Endpoint>('/endpoints', input),
    [keys.endpoints],
  );

export const usePatchEndpoint = (id: string) =>
  useApiMutation(
    (patch: Partial<EndpointInput>) => api.patch<Endpoint>(`/endpoints/${id}`, patch),
    [keys.endpoints],
  );

export const useDeleteEndpoint = () =>
  useApiMutation((id: string) => api.delete(`/endpoints/${id}`), [keys.endpoints]);

export const useClientConfig = (endpointId: string | undefined, client: ClientId) =>
  useQuery({
    queryKey: [...keys.endpoints, endpointId, 'client-config', client],
    enabled: Boolean(endpointId),
    queryFn: ({ signal }) =>
      api.get<ClientConfig>(`/endpoints/${endpointId}/client-config`, {
        query: { client },
        signal,
      }),
  });

// --- Store --------------------------------------------------------------------------------------
export const useStore = (q: string) =>
  useQuery({
    ...listQuery<StoreEntry>(keys.store, '/store', q ? { q } : {}),
    placeholderData: keepPreviousData,
  });

export const useStoreEntry = (slug: string | null) =>
  useQuery({
    queryKey: [...keys.store, 'entry', slug],
    enabled: Boolean(slug),
    queryFn: ({ signal }) => api.get<StoreEntryDetail>(`/store/${slug}`, { signal }),
  });

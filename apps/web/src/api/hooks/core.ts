import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../client';
import type {
  ClientConfig,
  ClientId,
  ConnectResult,
  EffectiveCapability,
  EgressHost,
  EgressRequest,
  Endpoint,
  EndpointInput,
  Installation,
  InstallationInput,
  InstallationPatch,
  Me,
  Notification,
  OrgSettings,
  OverrideDocument,
  OverridePreview,
  Quota,
  StoreEntry,
  StoreEntryDetail,
  ThemePref,
  TryResult,
} from '../types';
import { keys, listQuery, useApiMutation } from './base';

// --- Session and self -----------------------------------------------------------------------------
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<Me>('/me', { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });

export const useUpdateMe = () =>
  useApiMutation((patch: { theme: ThemePref }) => api.patch<Me>('/me', patch), [keys.me]);

export const useNotifications = () =>
  useQuery(listQuery<Notification>(keys.notifications, '/me/notifications', { limit: 50 }));

export const useMarkNotificationRead = () =>
  useApiMutation(
    (id: string) => api.post<void>(`/me/notifications/${id}/read`),
    [keys.notifications],
  );

export const useQuotas = () =>
  useQuery({
    queryKey: keys.quotas,
    queryFn: ({ signal }) =>
      api.get<{ items: Quota[] }>('/me/quotas', { signal }).then((r) => r.items),
  });

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

export const useEgress = (id: string) =>
  useQuery({
    queryKey: [...keys.installation(id), 'egress'],
    queryFn: ({ signal }) =>
      api.get<{ hosts: EgressHost[]; requests: EgressRequest[] }>(`/installations/${id}/egress`, {
        signal,
      }),
  });

export const useRequestEgress = (id: string) =>
  useApiMutation(
    (input: { host: string; reason: string }) =>
      api.post<EgressRequest>(`/installations/${id}/egress`, input),
    [[...keys.installation(id), 'egress']],
  );

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

// --- Settings (read by many screens) ---------------------------------------------------------------
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => api.get<OrgSettings>('/settings', { signal }),
  });

export const useInvalidate = () => {
  const qc = useQueryClient();
  return (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });
};

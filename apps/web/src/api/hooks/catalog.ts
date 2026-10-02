import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import type {
  AutoInstallInput,
  AutoInstallPolicy,
  AutoInstallPreview,
  CatalogDraftInput,
  CatalogEntry,
  CatalogEntryDetail,
  CatalogKind,
  CatalogVersion,
  ExecutableApproval,
  FileNode,
  Installation,
  InstallRequest,
  RegistryServer,
  SkillFile,
  TestResult,
} from '../types';
import { keys, listQuery, useApiMutation } from './base';

export const useCatalog = (params: { kind?: CatalogKind; q?: string } = {}) =>
  useQuery(listQuery<CatalogEntry>(keys.catalog, '/catalog', params));

export const useCatalogEntry = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.catalog, 'entry', id],
    enabled: Boolean(id),
    queryFn: ({ signal }) => api.get<CatalogEntryDetail>(`/catalog/${id}`, { signal }),
  });

export const useCreateCatalogEntry = () =>
  useApiMutation(
    (input: CatalogDraftInput) => api.post<CatalogEntryDetail>('/catalog', input),
    [keys.catalog],
  );

/** Saves the draft version of an entry: entry fields via PATCH, spec via the version. */
export const useSaveDraft = (entryId: string, versionId: string | null) =>
  useApiMutation(
    async (input: CatalogDraftInput) => {
      await api.patch<void>(`/catalog/${entryId}`, {
        displayName: input.displayName,
        description: input.description,
        visibility: input.visibility,
        risk: input.risk,
        autoUpgrade: input.autoUpgrade,
      });
      if (versionId) {
        return api.patch<CatalogVersion>(`/catalog/${entryId}/versions/${versionId}`, {
          spec: input.spec,
        });
      }
      return api.post<CatalogVersion>(`/catalog/${entryId}/versions`, { spec: input.spec });
    },
    [keys.catalog],
  );

export const useRunTest = (entryId: string, versionId: string) =>
  useApiMutation(
    () => api.post<TestResult>(`/catalog/${entryId}/versions/${versionId}/test`),
    [[...keys.catalog, 'entry', entryId]],
  );

export const useTestResult = (entryId: string, versionId: string | null) =>
  useQuery<TestResult | null>({
    queryKey: [...keys.catalog, 'test', entryId, versionId],
    enabled: Boolean(versionId),
    refetchInterval: (q) =>
      (q.state.data as TestResult | null | undefined)?.status === 'running' ? 800 : false,
    queryFn: ({ signal }) =>
      api.get<TestResult | null>(`/catalog/${entryId}/versions/${versionId}/test`, { signal }),
  });

export const usePublish = (entryId: string, versionId: string) =>
  useApiMutation(
    () => api.post<void>(`/catalog/${entryId}/versions/${versionId}/publish`),
    [keys.catalog, keys.store, keys.approvals],
  );

export const useApproveExecutable = () =>
  useApiMutation(
    (input: { entryId: string; versionId: string }) =>
      api.post<void>(`/catalog/${input.entryId}/versions/${input.versionId}/approve-executable`),
    [keys.catalog, keys.approvals, keys.marketplaces],
  );

export const useExecutableApprovals = (enabled = true) =>
  useQuery({
    ...listQuery<ExecutableApproval>(keys.approvals, '/catalog', { needsApproval: true }),
    enabled,
  });

export const useCatalogFiles = (entryId: string | undefined, versionId: string | undefined) =>
  useQuery({
    queryKey: [...keys.catalog, 'files', entryId, versionId],
    enabled: Boolean(entryId && versionId),
    queryFn: ({ signal }) =>
      api
        .get<{ items: FileNode[] }>(`/catalog/${entryId}/versions/${versionId}/files`, { signal })
        .then((r) => r.items),
  });

export const useCatalogFile = (
  entryId: string | undefined,
  versionId: string | undefined,
  path: string | null,
) =>
  useQuery({
    queryKey: [...keys.catalog, 'file', entryId, versionId, path],
    enabled: Boolean(entryId && versionId && path),
    queryFn: ({ signal }) =>
      api.get<SkillFile>(
        `/catalog/${entryId}/versions/${versionId}/files/${(path ?? '').split('/').map(encodeURIComponent).join('/')}`,
        { signal },
      ),
  });

export const useSaveFile = (entryId: string, versionId: string) =>
  useApiMutation(
    (file: { path: string; content: string }) =>
      api.put<void>(
        `/catalog/${entryId}/versions/${versionId}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        { content: file.content },
      ),
    [
      [...keys.catalog, 'files', entryId, versionId],
      [...keys.catalog, 'file', entryId, versionId],
    ],
  );

// --- Auto-install policies (11.5) ------------------------------------------------------------------
export const useAutoInstallPolicies = () =>
  useQuery(listQuery<AutoInstallPolicy>(keys.autoInstall, '/auto-install-policies'));

export const useSaveAutoInstall = () =>
  useApiMutation(
    (input: { id?: string; policy: AutoInstallInput }) =>
      input.id
        ? api.patch<AutoInstallPolicy>(`/auto-install-policies/${input.id}`, input.policy)
        : api.post<AutoInstallPolicy>('/auto-install-policies', input.policy),
    [keys.autoInstall],
  );

export const useDeleteAutoInstall = () =>
  useApiMutation((id: string) => api.delete(`/auto-install-policies/${id}`), [keys.autoInstall]);

export const usePreviewAutoInstall = () =>
  useApiMutation((input: { id?: string; policy: AutoInstallInput }) =>
    api.post<AutoInstallPreview>(
      `/auto-install-policies/${input.id ?? 'new'}/preview`,
      input.policy,
    ),
  );

// --- Registry (11.6, 11.7) --------------------------------------------------------------------------
export const useRegistryServers = (q: string) =>
  useQuery(listQuery<RegistryServer>(keys.registry, '/registry/servers', q ? { q } : {}));

export const useRegistryInstall = () =>
  useApiMutation(
    (input: { sourceId: string; name: string; version: string }) =>
      api.post<Installation>('/registry/install', input),
    [keys.registry, keys.installations],
  );

export const useInstallRequests = (status: 'open' | 'all' = 'open', enabled = true) =>
  useQuery({
    ...listQuery<InstallRequest>(
      keys.requests,
      '/install-requests',
      status === 'open' ? { status } : {},
    ),
    enabled,
  });

export const useCreateInstallRequest = () =>
  useApiMutation(
    (input: { sourceId: string; name: string; version: string; reason: string }) =>
      api.post<InstallRequest>('/install-requests', input),
    [keys.requests, keys.registry],
  );

export const useDecideRequest = () =>
  useApiMutation(
    (input: { id: string; decision: 'approve' | 'reject' }) =>
      api.post<void>(`/install-requests/${input.id}/${input.decision}`),
    [keys.requests],
  );

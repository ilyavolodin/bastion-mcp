import { useQuery } from '@tanstack/react-query';
import { fromBase64, toBase64 } from '@/lib/base64';
import { api, fetchAll, LOOKUP_PAGES } from '../client';
import type { Body, CatalogKind } from '../schema';
import { POLL_TEST_RUN_MS } from '../timing';
import {
  type AutoInstallView,
  type CatalogEntry,
  type CatalogEntryView,
  type CatalogVersion,
  type CatalogVersionDetail,
  type ExecutableApprovalView,
  toApprovalView,
  toAutoInstallView,
  toEntryView,
} from '../views/catalog';
import { keys, useApiMutation } from './base';
import { fetchTeamNames } from './lookups';

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Entries listed with their version labels need one `GET /catalog/{id}/versions` each: this many at most. */
const VERSION_FAN_OUT = 30;

/** Pages of plugin entries the approvals list walks (each entry costs further requests). */
const PLUGIN_ENTRY_PAGES = 2;

/**
 * How many real installations each entry has: the hidden test installations of the TEST flow (`origin: 'test'`) do
 * not count. `null` when the list could not be read; the API still refuses a delete that would orphan them.
 */
const realInstallationCounts = async (
  signal?: AbortSignal,
): Promise<Map<string, number> | null> => {
  try {
    const counts = new Map<string, number>();
    for (const i of await fetchAll('/installations', {}, undefined, signal)) {
      if (i.origin === 'test' || !i.catalogEntryId) continue;
      counts.set(i.catalogEntryId, (counts.get(i.catalogEntryId) ?? 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
};

// --- entries ----------------------------------------------------------------------------------------------------

/** Catalog entries with owner team and current version label (derived from the versions, bounded fan-out). */
export const useCatalog = (params: { kind?: CatalogKind; q?: string } = {}) =>
  useQuery({
    queryKey: [...keys.catalog, 'list', params],
    queryFn: async ({ signal }): Promise<CatalogEntryView[]> => {
      const [rows, names, installs] = await Promise.all([
        fetchAll('/catalog', params, undefined, signal),
        fetchTeamNames(signal),
        realInstallationCounts(signal),
      ]);
      const withVersions = new Map<string, CatalogVersion[]>();
      await Promise.all(
        rows
          .filter((e) => e.currentVersionId || e.status === 'draft')
          .slice(0, VERSION_FAN_OUT)
          .map(async (e) => {
            const page = await api.get(`/catalog/${e.id}/versions`, {
              query: { limit: 20 },
              signal,
            });
            withVersions.set(e.id, page.items);
          }),
      );
      return rows.map((e) =>
        toEntryView(e, {
          teamNames: names,
          versions: withVersions.get(e.id),
          installations: installs ? (installs.get(e.id) ?? 0) : null,
        }),
      );
    },
  });

export type CatalogEntryDetail = { entry: CatalogEntry; versions: CatalogVersion[] };

/** One entry with all its versions. */
export const useCatalogEntry = (id: string | undefined) =>
  useQuery({
    queryKey: [...keys.catalog, 'entry', id],
    enabled: Boolean(id),
    queryFn: async ({ signal }): Promise<CatalogEntryDetail> => {
      const [entry, versions] = await Promise.all([
        api.get(`/catalog/${id ?? ''}`, { signal }),
        fetchAll(`/catalog/${id ?? ''}/versions`, {}, LOOKUP_PAGES, signal),
      ]);
      return { entry, versions };
    },
  });

/** One version with its executable-content review (`approval`) and the latest test run. */
export const useCatalogVersion = (entryId: string | undefined, versionId: string | undefined) =>
  useQuery<CatalogVersionDetail>({
    queryKey: [...keys.catalog, 'version', entryId, versionId],
    enabled: Boolean(entryId && versionId),
    refetchInterval: (q) =>
      q.state.data?.testResult?.status === 'running' ? POLL_TEST_RUN_MS : false,
    queryFn: ({ signal }): Promise<CatalogVersionDetail> =>
      api.get(`/catalog/${entryId ?? ''}/versions/${versionId ?? ''}`, { signal }),
  });

/** Names of the org secrets that are set (never their values). */
export const useOrgSecretNames = (enabled = true) =>
  useQuery({
    queryKey: [...keys.catalog, 'org-secrets'],
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<Set<string>> =>
      new Set(
        (await api.get('/secrets', { query: { scope: 'org' }, signal })).items.map((s) => s.name),
      ),
  });

// --- test and publish ----------------------------------------------------------------------------------------------

/** Starts the automatic test of a version (11.2); progress arrives on the version row and over SSE. */
export const useRunTest = (entryId: string, versionId: string) =>
  useApiMutation(
    (input?: { variables?: Record<string, string> }) =>
      api.post(
        `/catalog/${entryId}/versions/${versionId}/test`,
        input?.variables && Object.keys(input.variables).length > 0
          ? { variables: input.variables }
          : undefined,
      ),
    [[...keys.catalog, 'version', entryId, versionId]],
  );

/**
 * A value the author types for the test only (11.3): a per-person secret field goes to the author's own secrets,
 * where the test installation finds it like any installer's value.
 */
export const useSetMySecret = () =>
  useApiMutation(
    (input: { userId: string; name: string; value: string }) =>
      api.put(
        `/secrets/user/${encodeURIComponent(input.userId)}/${encodeURIComponent(input.name)}`,
        { value: input.value },
        { etag: '*' },
      ),
    [[...keys.catalog, 'my-secrets']],
  );

/** Names of the secrets the signed-in person has set (never values). */
export const useMySecretNames = (enabled = true) =>
  useQuery({
    queryKey: [...keys.catalog, 'my-secrets'],
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<Set<string>> =>
      new Set(
        (await api.get('/secrets', { query: { scope: 'user' }, signal })).items.map((s) => s.name),
      ),
  });

export const usePublish = (entryId: string, versionId: string) =>
  useApiMutation(
    (body?: Body<'post', '/catalog/{id}/versions/{vid}/publish'>) =>
      api.post(`/catalog/${entryId}/versions/${versionId}/publish`, body),
    [keys.catalog, keys.store, keys.approvals],
  );

/** Publishes a tested draft from anywhere (the catalog list row); the editor uses `usePublish`. */
export const usePublishEntry = (onPublished?: () => void) =>
  useApiMutation(
    (input: {
      entryId: string;
      versionId: string;
      visibility: NonNullable<
        NonNullable<Body<'post', '/catalog/{id}/versions/{vid}/publish'>>['visibility']
      >;
    }) =>
      api.post(`/catalog/${input.entryId}/versions/${input.versionId}/publish`, {
        visibility: input.visibility,
      }),
    [keys.catalog, keys.store, keys.approvals],
    { onSuccess: () => onPublished?.() },
  );

/**
 * Deletes an entry (11.1). Hidden test installations go with it; real installations make the API answer 409
 * `entry_in_use` with what to do instead.
 */
export const useDeleteCatalogEntry = (onDeleted?: () => void) =>
  useApiMutation(
    (id: string) => api.delete(`/catalog/${id}`, { etag: '*' }),
    // Only the lists: the deleted entry's own queries must not refetch (they would 404 under the open editor).
    [[...keys.catalog, 'list'], keys.store, keys.installations, keys.autoInstall],
    { onSuccess: () => onDeleted?.() },
  );

/** Deprecates (hidden from the Store) or archives a published entry (11.1). */
export const useSetEntryStatus = (onDone?: () => void) =>
  useApiMutation(
    (input: { id: string; status: 'deprecated' | 'archived' }) =>
      api.patch(`/catalog/${input.id}`, { status: input.status }, { etag: '*' }),
    [keys.catalog, keys.store],
    { onSuccess: () => onDone?.() },
  );

export const useApproveExecutable = () =>
  useApiMutation(
    (input: { entryId: string; versionId: string; reviewedDiffSha256?: string }) =>
      api.post(
        `/catalog/${input.entryId}/versions/${input.versionId}/approve-executable`,
        input.reviewedDiffSha256 ? { reviewedDiffSha256: input.reviewedDiffSha256 } : undefined,
      ),
    [keys.catalog, keys.approvals, keys.marketplaces],
  );

/**
 * Plugin versions waiting for an Admin. The API has no "needs approval" list filter (17.2), so this walks the plugin
 * entries and their draft versions and keeps those whose `approval.status` is `pending`.
 */
export const useExecutableApprovals = (enabled = true) =>
  useQuery({
    queryKey: [...keys.approvals],
    enabled,
    queryFn: async ({ signal }): Promise<ExecutableApprovalView[]> => {
      const [entries, users] = await Promise.all([
        fetchAll('/catalog', { kind: 'plugin' }, PLUGIN_ENTRY_PAGES, signal),
        fetchAll('/users', {}, LOOKUP_PAGES, signal),
      ]);
      const names = new Map(users.map((u) => [u.id, u.displayName]));
      const perEntry = await Promise.all(
        entries.map(async (entry) => {
          const versions = await api.get(`/catalog/${entry.id}/versions`, {
            query: { limit: 5 },
            signal,
          });
          const drafts = versions.items.filter((v) => v.status === 'draft');
          const details = await Promise.all(
            drafts.map((v) => api.get(`/catalog/${entry.id}/versions/${v.id}`, { signal })),
          );
          return details
            .filter((v) => v.approval?.status === 'pending')
            .map((v) => toApprovalView(entry, v, names.get(v.createdBy)));
        }),
      );
      return perEntry.flat();
    },
  });

// --- files (25.2) ---------------------------------------------------------------------------------------------------

export const useCatalogFiles = (entryId: string | undefined, versionId: string | undefined) =>
  useQuery({
    queryKey: [...keys.catalog, 'files', entryId, versionId],
    enabled: Boolean(entryId && versionId),
    queryFn: ({ signal }) =>
      api
        .get(`/catalog/${entryId ?? ''}/versions/${versionId ?? ''}/files`, { signal })
        .then((r) => r.items),
  });

/** One file with its text decoded from `contentBase64`. */
export const useCatalogFile = (
  entryId: string | undefined,
  versionId: string | undefined,
  path: string | null,
) =>
  useQuery({
    queryKey: [...keys.catalog, 'file', entryId, versionId, path],
    enabled: Boolean(entryId && versionId && path),
    queryFn: async ({ signal }) => {
      const file = await api.get(
        `/catalog/${entryId ?? ''}/versions/${versionId ?? ''}/files/${encodePath(path ?? '')}`,
        { signal },
      );
      return { ...file, content: fromBase64(file.contentBase64) };
    },
  });

export const useSaveFile = (entryId: string, versionId: string) =>
  useApiMutation(
    (file: { path: string; content: string; executable?: boolean }) =>
      api.put(`/catalog/${entryId}/versions/${versionId}/files/${encodePath(file.path)}`, {
        contentBase64: toBase64(file.content),
        mode: file.executable ? 'executable' : 'file',
      }),
    [
      [...keys.catalog, 'files', entryId, versionId],
      [...keys.catalog, 'file', entryId, versionId],
      [...keys.catalog, 'version', entryId, versionId],
    ],
  );

// --- auto-install policies (11.5) -------------------------------------------------------------------------------------

/** Policies with the entry name and one chip per audience. */
export const useAutoInstallPolicies = () =>
  useQuery({
    queryKey: keys.autoInstall,
    queryFn: async ({ signal }): Promise<AutoInstallView[]> => {
      const [rows, entries, names] = await Promise.all([
        fetchAll('/auto-install-policies', {}, undefined, signal),
        fetchAll('/catalog', {}, undefined, signal),
        fetchTeamNames(signal),
      ]);
      const entryNames = new Map(entries.map((e) => [e.id, e.displayName]));
      return rows.map((r) => toAutoInstallView(r, { entryNames, teamNames: names }));
    },
  });

export const useSaveAutoInstall = () =>
  useApiMutation(
    (
      input:
        | { id: string; policy: Body<'patch', '/auto-install-policies/{id}'> }
        | { id?: undefined; policy: Body<'post', '/auto-install-policies'> },
    ) =>
      input.id === undefined
        ? api.post('/auto-install-policies', input.policy)
        : api.patch(`/auto-install-policies/${input.id}`, input.policy),
    [keys.autoInstall],
  );

export const useDeleteAutoInstall = () =>
  useApiMutation((id: string) => api.delete(`/auto-install-policies/${id}`), [keys.autoInstall]);

/**
 * Who a stored policy would reach (11.5). The API previews a stored policy with optional unsaved changes
 * (target, mode, scope, applyToExisting), so a policy that is not saved yet has no preview.
 */
export const usePreviewAutoInstall = () =>
  useApiMutation(
    (input: { id: string; changes: Body<'post', '/auto-install-policies/{id}/preview'> }) =>
      api.post(`/auto-install-policies/${input.id}/preview`, input.changes),
  );

import { useQuery } from '@tanstack/react-query';
import {
  type Draft,
  toEntryCreateBody,
  toEntryPatchBody,
  toVersionBody,
} from '@/features/catalog/draft';
import { fromBase64, toBase64 } from '@/lib/base64';
import { api, fetchAll } from '../client';
import type { Body, CatalogKind } from '../schema';
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

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Teams by id, for the owner and audience labels of the catalog screens. */
const teamNames = async (signal?: AbortSignal): Promise<Map<string, string>> =>
  new Map((await fetchAll('/teams', {}, 5, signal)).map((t) => [t.id, t.displayName]));

/** Entries listed with their version labels need one `GET /catalog/{id}/versions` each: this many at most. */
const VERSION_FAN_OUT = 30;

// --- entries ----------------------------------------------------------------------------------------------------

/** Catalog entries with owner team and current version label (derived from the versions, bounded fan-out). */
export const useCatalog = (params: { kind?: CatalogKind; q?: string } = {}) =>
  useQuery({
    queryKey: [...keys.catalog, 'list', params],
    queryFn: async ({ signal }): Promise<CatalogEntryView[]> => {
      const [rows, names] = await Promise.all([
        fetchAll('/catalog', params, 20, signal),
        teamNames(signal),
      ]);
      const withVersions = new Map<string, CatalogVersion[]>();
      await Promise.all(
        rows
          .filter((e) => e.currentVersionId)
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
        toEntryView(e, { teamNames: names, versions: withVersions.get(e.id) }),
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
        fetchAll(`/catalog/${id ?? ''}/versions`, {}, 5, signal),
      ]);
      return { entry, versions };
    },
  });

/** One version with its executable-content review (`approval`) and the latest test run. */
export const useCatalogVersion = (entryId: string | undefined, versionId: string | undefined) =>
  useQuery<CatalogVersionDetail>({
    queryKey: [...keys.catalog, 'version', entryId, versionId],
    enabled: Boolean(entryId && versionId),
    refetchInterval: (q) => (q.state.data?.testResult?.status === 'running' ? 800 : false),
    queryFn: ({ signal }): Promise<CatalogVersionDetail> =>
      api.get(`/catalog/${entryId ?? ''}/versions/${versionId ?? ''}`, { signal }),
  });

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
/** JSON equality that ignores key order. */
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const isDefaultOverrides = (doc: Record<string, unknown>) =>
  Object.keys(doc).length === 0 || sameJson(doc, { version: 1 });

/** Creates the draft entry, then its first version (a draft entry has no version of its own, 11.1). */
export const useCreateCatalogEntry = () =>
  useApiMutation(
    async (draft: Draft) => {
      const entry = await api.post('/catalog', toEntryCreateBody(draft));
      const version = await api.post(`/catalog/${entry.id}/versions`, toVersionBody(draft));
      if (!isDefaultOverrides(draft.overrides))
        await api.put(`/catalog/${entry.id}/versions/${version.id}/overrides`, draft.overrides);
      return { entry, version };
    },
    [keys.catalog],
  );

/**
 * Saves a draft: the entry fields by PATCH, the version by PATCH (or a new draft version when the entry has none),
 * the default overrides by PUT. A version is only patched when its spec, form or label changed: any patch of the spec
 * invalidates the test (11.2).
 */
export const useSaveDraft = (entryId: string, version: CatalogVersion | undefined) =>
  useApiMutation(
    async (draft: Draft) => {
      await api.patch(`/catalog/${entryId}`, toEntryPatchBody(draft));
      const body = toVersionBody(draft);
      if (version?.status !== 'draft') {
        const created = await api.post(`/catalog/${entryId}/versions`, body);
        if (!isDefaultOverrides(draft.overrides))
          await api.put(`/catalog/${entryId}/versions/${created.id}/overrides`, draft.overrides);
        return created;
      }
      const changed =
        version.label !== body.label ||
        !sameJson(version.serverSpec, body.serverSpec) ||
        !sameJson(version.installForm, body.installForm);
      const saved = changed
        ? await api.patch(`/catalog/${entryId}/versions/${version.id}`, body)
        : version;
      if (!sameJson(version.overrides, draft.overrides))
        await api.put(`/catalog/${entryId}/versions/${version.id}/overrides`, draft.overrides);
      return saved;
    },
    [keys.catalog],
  );

// --- test and publish ----------------------------------------------------------------------------------------------

/** Starts the automatic test of a version (11.2); progress arrives on the version row and over SSE. */
export const useRunTest = (entryId: string, versionId: string) =>
  useApiMutation(
    () => api.post(`/catalog/${entryId}/versions/${versionId}/test`),
    [[...keys.catalog, 'version', entryId, versionId]],
  );

export const usePublish = (entryId: string, versionId: string) =>
  useApiMutation(
    (body?: Body<'post', '/catalog/{id}/versions/{vid}/publish'>) =>
      api.post(`/catalog/${entryId}/versions/${versionId}/publish`, body),
    [keys.catalog, keys.store, keys.approvals],
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
        fetchAll('/catalog', { kind: 'plugin' }, 2, signal),
        fetchAll('/users', {}, 5, signal),
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
        fetchAll('/auto-install-policies', {}, 20, signal),
        fetchAll('/catalog', {}, 20, signal),
        teamNames(signal),
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

/** Teams for the audience pickers: id and name. */
export const useTeamOptions = () =>
  useQuery({
    queryKey: [...keys.catalog, 'team-options'],
    queryFn: async ({ signal }) =>
      (await fetchAll('/teams', {}, 5, signal)).map((t) => ({ id: t.id, name: t.displayName })),
  });

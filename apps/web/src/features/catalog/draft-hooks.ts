import { api } from '@/api/client';
import { keys, useApiMutation } from '@/api/hooks/base';
import type { CatalogVersion } from '@/api/views/catalog';
import { asRecord } from '@/lib/json';
import {
  type Draft,
  needsClientSecret,
  normalizeOverrides,
  oauthClientSecretName,
  sameJson,
  secretNamesOf,
  toEntryCreateBody,
  toEntryPatchBody,
  toVersionBody,
  versionChanged,
  withStoredLockfile,
} from './draft';

/** Mutations that save the editor's `Draft`: they live with the draft module they convert, not in the api layer. */

const isDefaultOverrides = (doc: Record<string, unknown>) =>
  Object.keys(doc).length === 0 || sameJson(doc, { version: 1 });

/**
 * The shared secrets typed in the editor (`orgSecret`, 9.5) go to the secrets API, which encrypts them and never
 * returns them. Only names with a typed value are written; the form forgets the values after a save.
 */
const writeOrgSecrets = async (draft: Draft): Promise<void> => {
  const spec = draft.spec;
  const names = needsClientSecret(spec)
    ? [oauthClientSecretName(spec.oauthClient)]
    : spec.authMode === 'orgSecret'
      ? secretNamesOf(spec)
      : [];
  for (const name of names) {
    const value = spec.secretValues[name];
    if (value)
      await api.put(`/secrets/org/org/${encodeURIComponent(name)}`, { value }, { etag: '*' });
  }
};

/**
 * Creates the draft entry, then its first version (a draft entry has no version of its own, 11.1). When the version
 * is refused the entry is removed again, so a second save does not collide with the half-created one.
 */
export const useCreateCatalogEntry = () =>
  useApiMutation(
    async (draft: Draft) => {
      const entry = await api.post('/catalog', toEntryCreateBody(draft));
      try {
        const version = await api.post(`/catalog/${entry.id}/versions`, toVersionBody(draft));
        if (!isDefaultOverrides(draft.overrides))
          await api.put(`/catalog/${entry.id}/versions/${version.id}/overrides`, draft.overrides, {
            etag: '*',
          });
        await writeOrgSecrets(draft);
        return { entry, version };
      } catch (e) {
        await api.delete(`/catalog/${entry.id}`, { etag: '*' }).catch(() => undefined);
        throw e;
      }
    },
    [keys.catalog],
  );

/**
 * Saves a draft: the entry fields by PATCH, the version by PATCH (or a new draft version when the entry has none),
 * the default overrides by PUT, the shared secrets by the secrets API. A version is only patched when its spec, form
 * or label changed: any patch of the spec invalidates the test (11.2).
 */
export const useSaveDraft = (entryId: string, version: CatalogVersion | undefined) =>
  useApiMutation(
    async (draft: Draft) => {
      await api.patch(`/catalog/${entryId}`, toEntryPatchBody(draft));
      await writeOrgSecrets(draft);
      const body = toVersionBody(draft);
      if (version?.status !== 'draft') {
        const created = await api.post(`/catalog/${entryId}/versions`, body);
        if (!isDefaultOverrides(draft.overrides))
          await api.put(`/catalog/${entryId}/versions/${created.id}/overrides`, draft.overrides, {
            etag: '*',
          });
        return created;
      }
      const patch = withStoredLockfile(body, asRecord(version.serverSpec));
      const saved = versionChanged(version, patch)
        ? await api.patch(`/catalog/${entryId}/versions/${version.id}`, patch)
        : version;
      if (!sameJson(normalizeOverrides(version.overrides), draft.overrides))
        await api.put(`/catalog/${entryId}/versions/${version.id}/overrides`, draft.overrides, {
          etag: '*',
        });
      return saved;
    },
    [keys.catalog],
  );

/**
 * Saves only the entry's own fields (who gets it, risk, description, update settings) on a published entry whose
 * version did not change: no new version, so no new test.
 */
export const useSaveEntry = (entryId: string) =>
  useApiMutation(
    (draft: Draft) => api.patch(`/catalog/${entryId}`, toEntryPatchBody(draft)),
    [keys.catalog, keys.store],
  );

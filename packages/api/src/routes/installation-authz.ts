import { authz } from '../framework/route';
import {
  loadCatalogEntryResource,
  loadInstallationResource,
  unownedEntry,
  unownedInstallation,
} from '../services/resources';

/** Authorizes against the addressed installation (a missing row cannot be told from a forbidden one). */
export const onInstallation = (rule: string) =>
  authz.on(
    rule,
    async ({ deps, params }) =>
      (await loadInstallationResource(deps, params.id ?? '')) ??
      unownedInstallation(params.id ?? ''),
  );

/** Authorizes against the addressed catalog entry (a missing row looks like a forbidden one). */
export const onCatalogEntry = (rule: string) =>
  authz.on(
    rule,
    async ({ deps, params }) =>
      (await loadCatalogEntryResource(deps, params.id ?? '')) ?? unownedEntry(params.id ?? ''),
  );

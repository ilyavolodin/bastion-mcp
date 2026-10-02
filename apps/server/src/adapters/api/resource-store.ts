/**
 * `ResourceStore` of the control-plane API over Postgres (17.1, 16.2): the 34 collections of
 * `packages/api/src/ports/store.ts` mapped onto the Prisma models. Plain tables are described declaratively
 * (`store/specs.ts`); the few that are not one table are in `store/custom.ts`.
 *
 * Inside a unit of work the store joins the transaction and records config-version bumps in the unit, so they are
 * applied and published after commit (4.3). Outside one (plain reads) it just reads.
 */
import {
  COLLECTIONS,
  type Collection,
  type ListQuery,
  type Page,
  type ResourceStore,
  type Row,
} from '@bastion-mcp/api';
import { newId } from '@bastion-mcp/core';
import type { PrismaClient, UnitState } from '@bastion-mcp/db';
import {
  type CollectionStore,
  createCollection,
  type Db,
  type StoreContext,
} from './store/collection';
import {
  createInstallationSecrets,
  createOAuthGrants,
  createOverridesCollection,
  createServiceAccountClients,
  createSettingsCollection,
} from './store/custom';
import { loadStoreMeta, type StoreMeta } from './store/meta';
import { SPECS } from './store/specs';

export type ResourceStoreOptions = {
  /** The unit that records config bumps when the store runs inside a transaction. */
  unit?: UnitState | undefined;
  newId?: () => string;
};

const CUSTOM: Partial<Record<Collection, (ctx: StoreContext) => CollectionStore>> = {
  settings: createSettingsCollection,
  service_account_clients: createServiceAccountClients,
  oauth_grants: createOAuthGrants,
  installation_secrets: createInstallationSecrets,
  overrides: () => createOverridesCollection(),
};

/** Loads the schema metadata once per Prisma client; pass the result to every `createResourceStore`. */
export const loadResourceStoreMeta = (prisma: PrismaClient): Promise<StoreMeta> =>
  loadStoreMeta(prisma);

export const createResourceStore = (
  db: Db,
  meta: StoreMeta,
  options: ResourceStoreOptions = {},
): ResourceStore => {
  const ctx: StoreContext = { db, meta, unit: options.unit, newId: options.newId ?? newId };
  const cache = new Map<Collection, CollectionStore>();
  const collection = (name: Collection): CollectionStore => {
    let found = cache.get(name);
    if (!found) {
      const custom = CUSTOM[name];
      const spec = SPECS[name];
      if (custom) found = custom(ctx);
      else if (spec) found = createCollection(ctx, spec);
      else throw new Error(`collection ${name} is not mapped`);
      cache.set(name, found);
    }
    return found;
  };
  // Every collection the API declares must be mapped: fail at construction, not on the first request.
  for (const name of COLLECTIONS) {
    if (!CUSTOM[name] && !SPECS[name]) throw new Error(`collection ${name} is not mapped`);
  }
  return {
    list: (name: Collection, query: ListQuery): Promise<Page<Row>> => collection(name).list(query),
    get: (name, id) => collection(name).get(id),
    find: (name, where) => collection(name).find(where),
    insert: (name, data) => collection(name).insert(data),
    update: (name, id, patch) => collection(name).update(id, patch),
    upsert: (name, id, data) => collection(name).upsert(id, data),
    remove: (name, id) => collection(name).remove(id),
  };
};

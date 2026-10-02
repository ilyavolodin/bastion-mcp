import type { MemoryStore } from '../memory-store';
import { W } from '../world';

const remoteSpec = (url: string, auth: 'none' | 'oauth' = 'none') => ({
  type: 'remote',
  transport: 'streamable-http',
  url,
  auth: { mode: auth },
});

type Row = Record<string, unknown> & { id: string };
type Coll = Parameters<MemoryStore['seed']>[0];

const seedOnce = async (store: MemoryStore, collection: Coll, row: Row): Promise<void> => {
  if (!(await store.get(collection, row.id))) await store.seed(collection, row);
};

const entry = (id: string, extra: Record<string, unknown>): Row => ({
  id,
  slug: id,
  kind: 'mcp_server',
  displayName: id,
  description: id,
  status: 'published',
  risk: 'low',
  userOverrides: 'cosmetic',
  currentVersionId: `ver-${id}`,
  visibility: { org: false, teamIds: [], userIds: [] },
  ...extra,
});

const version = (entryId: string, auth: 'none' | 'oauth' = 'none'): Row => ({
  id: `ver-${entryId}`,
  entryId,
  label: '1.0.0',
  status: 'published',
  serverSpec: remoteSpec(`https://${entryId}.example.com/mcp`, auth),
  overrides: {},
});

/**
 * Entries `entry-team-a`, `entry-org`, `entry-team-b` (shared with the catalog area; kept when present), the
 * installation area's own entry `entry-i-pub` (org-visible, OAuth), installations of every owner kind, an
 * endpoint, an open drift review and two auto-install policies.
 */
export const seedInstallations = async (store: MemoryStore): Promise<void> => {
  const entries: Row[] = [
    entry('entry-team-a', {
      ownerTeamId: W.teamA,
      visibility: { org: false, teamIds: [W.teamA], userIds: [] },
    }),
    entry('entry-team-b', {
      ownerTeamId: W.teamB,
      visibility: { org: false, teamIds: [W.teamB], userIds: [] },
    }),
    entry('entry-org', { visibility: { org: true, teamIds: [], userIds: [] } }),
    entry('entry-i-pub', {
      visibility: { org: true, teamIds: [], userIds: [] },
      userOverrides: 'full',
    }),
    entry('entry-i-none', {
      visibility: { org: true, teamIds: [], userIds: [] },
      userOverrides: 'none',
    }),
    entry('entry-i-draft', {
      status: 'draft',
      ownerTeamId: W.teamA,
      currentVersionId: null,
      visibility: { org: false, teamIds: [W.teamA], userIds: [] },
    }),
  ];
  for (const e of entries) await seedOnce(store, 'catalog_entries', e);
  for (const id of ['entry-team-a', 'entry-team-b', 'entry-org', 'entry-i-none']) {
    await seedOnce(store, 'catalog_versions', version(id));
  }
  await seedOnce(store, 'catalog_versions', version('entry-i-pub', 'oauth'));
  await seedOnce(store, 'catalog_versions', {
    ...version('entry-i-draft'),
    id: 'ver-draft-i',
    entryId: 'entry-i-draft',
    status: 'draft',
  });
  await seedOnce(store, 'catalog_versions', {
    ...version('entry-team-a'),
    id: 'ver-team-a-draft',
    entryId: 'entry-team-a',
    status: 'draft',
  });

  const inst = (id: string, ownerType: string, ownerId: string, entryId: string): Row => ({
    id,
    ownerType,
    ownerId,
    catalogEntryId: entryId,
    catalogVersionId: `ver-${entryId}`,
    pinnedVersion: false,
    personalSpec: null,
    slug: id,
    toolPrefix: id.replace(/-/g, '_'),
    displayName: id,
    enabled: true,
    variables: {},
    secretRefs: {},
    overrides: {},
    origin: 'catalog',
    status: 'ready',
  });
  await store.seed('installations', inst('inst-member-a', 'user', W.memberA, 'entry-org'));
  await store.seed('installations', inst('inst-member-b', 'user', W.memberB, 'entry-org'));
  await store.seed('installations', inst('inst-team-a', 'team', W.teamA, 'entry-team-a'));
  await store.seed('installations', inst('inst-team-b', 'team', W.teamB, 'entry-team-b'));
  await store.seed('installations', inst('inst-svc-a', 'service', W.svc, 'entry-org'));
  await store.seed('endpoints', {
    id: 'ep-member-a',
    ownerType: 'user',
    ownerId: W.memberA,
    slug: 'work',
    displayName: 'Work',
    installationIds: ['inst-member-a'],
    prefixMode: 'always',
  });
  await store.seed('endpoints', {
    id: 'ep-member-b',
    ownerType: 'user',
    ownerId: W.memberB,
    slug: 'work',
    displayName: 'Work B',
    installationIds: ['inst-member-b'],
    prefixMode: 'always',
  });
  await store.seed('drift_reviews', {
    id: 'drift-1',
    installationId: 'inst-team-a',
    itemKind: 'tool',
    itemKey: 'search',
    status: 'open',
    newHash: 'sha-new',
    newDefinition: { name: 'search', description: 'changed' },
    guardResults: {},
  });
  await store.seed('drift_reviews', {
    id: 'drift-2',
    installationId: 'inst-team-a',
    itemKind: 'tool',
    itemKey: 'delete',
    status: 'open',
    newHash: 'sha-new-2',
    newDefinition: { name: 'delete' },
    guardResults: {},
  });
  await store.seed('auto_install_policies', {
    id: 'aip-team-a',
    catalogEntryId: 'entry-i-pub',
    target: { teamIds: [W.teamA] },
    mode: 'default',
    scope: 'user',
    applyToExisting: true,
    enabled: true,
    createdBy: W.admin,
  });
  await store.seed('auto_install_policies', {
    id: 'aip-org',
    catalogEntryId: 'entry-i-pub',
    target: { all: true },
    mode: 'required',
    scope: 'user',
    applyToExisting: true,
    enabled: true,
    createdBy: W.admin,
  });
};

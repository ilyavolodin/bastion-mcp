import { sha256Hex } from '@bastion-mcp/core';
import type { MemoryStore } from '../memory-store';
import { W } from '../world';

/** File bodies of the seeded plugin version; `fakeCatalogDeps` preloads them into the blob store. */
export const SEED_FILES = {
  'SKILL.md': '---\nname: demo\ndescription: demo skill\n---\nHelp the user.\n',
  'scripts/run.sh': '#!/bin/sh\necho hi\n',
} as const;

export const REMOTE_SPEC = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  auth: { mode: 'none' },
} as const;

const FORM = { variables: [], secrets: [] };

const entry = (
  id: string,
  slug: string,
  ownerTeamId: string | null,
  visibility: { org: boolean; teamIds: string[]; userIds: string[] },
  extra: Record<string, unknown> = {},
) => ({
  id,
  slug,
  kind: 'mcp_server',
  displayName: slug,
  description: `${slug} description`,
  tags: [],
  ownerTeamId,
  visibility,
  status: 'published',
  risk: 'low',
  source: { kind: 'manual' },
  autoUpgrade: true,
  userOverrides: 'cosmetic',
  onDrift: 'hideChanged',
  createdBy: W.admin,
  ...extra,
});

const version = (id: string, entryId: string, label: string, status: string, extra = {}) => ({
  id,
  entryId,
  label,
  serverSpec: REMOTE_SPEC,
  installForm: FORM,
  status,
  changelog: null,
  createdBy: W.admin,
  ...extra,
});

const passed = { status: 'passed', steps: [] };

/**
 * Catalog fixtures (11.1): team A, org-wide and team B server entries, each with a draft and (for team A)
 * a published version, plus a draft plugin entry owned by team A with an executable file.
 */
export const seedCatalog = async (store: MemoryStore): Promise<void> => {
  const none = { org: false, teamIds: [] as string[], userIds: [] as string[] };
  await store.seed(
    'catalog_entries',
    entry(
      'entry-team-a',
      'team-a-server',
      W.teamA,
      { ...none, teamIds: [W.teamA] },
      {
        currentVersionId: 'ver-team-a-pub',
      },
    ),
  );
  await store.seed(
    'catalog_entries',
    entry('entry-org', 'org-server', null, { ...none, org: true }, { currentVersionId: 'ver-org' }),
  );
  await store.seed(
    'catalog_entries',
    entry(
      'entry-team-b',
      'team-b-server',
      W.teamB,
      { ...none, teamIds: [W.teamB] },
      {
        currentVersionId: 'ver-team-b',
      },
    ),
  );
  await store.seed(
    'catalog_entries',
    entry(
      'entry-plugin',
      'demo-plugin',
      W.teamA,
      { ...none, teamIds: [W.teamA] },
      {
        kind: 'plugin',
        status: 'draft',
        currentVersionId: null,
      },
    ),
  );
  await store.seed(
    'catalog_versions',
    version('ver-team-a', 'entry-team-a', '2', 'draft', { testResult: passed }),
  );
  await store.seed(
    'catalog_versions',
    version('ver-team-a-pub', 'entry-team-a', '1', 'published', {
      testResult: passed,
      publishedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  await store.seed(
    'catalog_versions',
    version('ver-org', 'entry-org', '1', 'published', { testResult: passed }),
  );
  await store.seed(
    'catalog_versions',
    version('ver-team-b', 'entry-team-b', '1', 'published', { testResult: passed }),
  );
  await store.seed('catalog_versions', version('ver-team-b-draft', 'entry-team-b', '2', 'draft'));
  await store.seed('catalog_versions', {
    id: 'ver-plugin',
    entryId: 'entry-plugin',
    label: '1.0.0',
    serverSpec: null,
    installForm: FORM,
    status: 'draft',
    changelog: null,
    createdBy: W.admin,
    testResult: passed,
  });
  const files: Array<[string, 'file' | 'executable', 'plain' | 'executable']> = [
    ['SKILL.md', 'file', 'plain'],
    ['scripts/run.sh', 'executable', 'executable'],
  ];
  for (const [path, mode, classification] of files) {
    await store.seed('catalog_files', {
      id: `ver-plugin:${path}`,
      catalogVersionId: 'ver-plugin',
      path,
      blobSha256: sha256Hex(SEED_FILES[path as keyof typeof SEED_FILES]),
      mode,
      classification,
      size: SEED_FILES[path as keyof typeof SEED_FILES].length,
    });
  }
  await store.seed('plugin_sources', {
    id: 'psrc-1',
    name: 'Shared skills',
    gitUrl: 'https://git.example.com/skills.git',
    ref: 'main',
    path: null,
    authSecretId: null,
    tracked: true,
    lastCommit: null,
    lastSync: null,
  });
};

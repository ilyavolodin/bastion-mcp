import { basename } from 'node:path';
import {
  discoverItems,
  extractSubtree,
  loadVersionFiles,
  type PluginFile,
  planSourceSync,
  saveVersionFiles,
} from '@bastion-mcp/plugins';
import type { Infra } from '../infra';
import { draftFromFiles } from './plugin-content';
import { readRepository } from './plugin-import';

export type PluginSyncResult = { imported: number; updated: number; errors: string[] };

const slugOf = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plugin';

const fromBase64 = (files: { path: string; contentBase64: string }[]): PluginFile[] =>
  files.map((f) => ({
    path: f.path,
    content: new Uint8Array(Buffer.from(f.contentBase64, 'base64')),
    mode: 'file',
  }));

/**
 * Plugin source sync (25.2, scheduler job `plugin-source-sync`): reads the repository at the tracked ref, discovers its
 * plugins and skills and, per item, creates a draft entry (first sight) or a new draft version when the tree changed.
 * Nothing is published automatically: an author tests and publishes the draft (11.3). Entries are created on behalf
 * of the oldest admin because the job has no human actor.
 */
export const syncPluginSource = async (
  infra: Infra,
  sourceId: string,
): Promise<PluginSyncResult> => {
  const result: PluginSyncResult = { imported: 0, updated: 0, errors: [] };
  const source = await infra.repos.pluginSources.get(sourceId);
  if (!source) {
    result.errors.push('plugin source not found');
    return result;
  }
  const prisma = infra.db.prisma;
  try {
    const admin = await prisma.user.findFirst({
      where: { orgRole: 'admin', status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!admin) throw new Error('no active admin to own imported drafts');
    const password = source.authSecretId
      ? ((await infra.secretStore.revealById(source.authSecretId)) ?? undefined)
      : undefined;
    const tree = await readRepository(infra, {
      url: source.gitUrl,
      ref: source.ref,
      ...(password ? { password } : {}),
    });
    const scope = source.path
      ? extractSubtree(tree.files, source.path.replace(/^\/+|\/+$/g, ''))
      : tree.files;
    const items = discoverItems(scope).filter((i) => !i.external);
    for (const item of items) {
      try {
        const files = extractSubtree(scope, item.dir);
        const label = item.name ?? (basename(source.gitUrl).replace(/\.git$/, '') || source.name);
        const draft = draftFromFiles(files, label);
        const dir = source.path ? `${source.path}/${item.dir}` : item.dir;
        const existing = await prisma.catalogEntry.findFirst({
          where: {
            AND: [
              { source: { path: ['kind'], equals: 'plugin_source' } },
              { source: { path: ['pluginSourceId'], equals: source.id } },
              { source: { path: ['dir'], equals: dir } },
            ],
          },
        });
        const draftFiles = fromBase64(draft.files ?? []);
        if (!existing) {
          const entry = await infra.repos.catalogEntries.create({
            slug: await freeSlug(infra, slugOf(draft.name)),
            kind: draft.kind,
            displayName: draft.name,
            description: draft.description ?? '',
            source: { kind: 'plugin_source', pluginSourceId: source.id, dir, commit: tree.commit },
            createdBy: admin.id,
          });
          const version = await infra.repos.catalogVersions.create({
            entryId: entry.id,
            label: tree.commit.slice(0, 12),
            serverSpec: {},
            installForm: { variables: [], secrets: [] },
            createdBy: admin.id,
          });
          await saveVersionFiles(
            { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
            version.id,
            draftFiles,
          );
          result.imported += 1;
          continue;
        }
        const last = (existing.source as { commit?: string } | null)?.commit;
        const versions = await infra.repos.catalogVersions.list(existing.id);
        const newest = versions[0];
        const previous = newest
          ? await loadVersionFiles(
              { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
              newest.id,
            )
          : undefined;
        const plan = planSourceSync({
          lastCommit: last,
          previous,
          commit: tree.commit,
          files: draftFiles,
        });
        if (plan.action === 'none') continue;
        const version = await infra.repos.catalogVersions.create({
          entryId: existing.id,
          label: tree.commit.slice(0, 12),
          serverSpec: {},
          installForm: { variables: [], secrets: [] },
          createdBy: admin.id,
        });
        await saveVersionFiles(
          { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
          version.id,
          draftFiles,
        );
        await prisma.catalogEntry.update({
          where: { id: existing.id },
          data: { source: { ...(existing.source as object), commit: tree.commit } },
        });
        result.updated += 1;
      } catch (error) {
        result.errors.push(
          `${item.name ?? item.dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await infra.repos.pluginSources.recordSync(source.id, {
      lastCommit: tree.commit,
      lastSync: {
        at: new Date(infra.clock.now()).toISOString(),
        ...result,
        ok: result.errors.length === 0,
      },
    });
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    await infra.repos.pluginSources
      .recordSync(source.id, {
        lastCommit: source.lastCommit,
        lastSync: { at: new Date(infra.clock.now()).toISOString(), ...result, ok: false },
      })
      .catch(() => undefined);
  }
  return result;
};

const freeSlug = async (infra: Infra, base: string): Promise<string> => {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await infra.repos.catalogEntries.getBySlug(candidate))) return candidate;
  }
  throw new Error('could not find a free catalog slug');
};

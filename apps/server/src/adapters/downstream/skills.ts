import { MS, TtlCache } from '@bastion-mcp/core';
import type { SkillsProvider } from '@bastion-mcp/mcp-downstream';
import {
  buildSkillIndex,
  getSkill,
  listSkills,
  type ReleaseItem,
  readSkillResource,
  type SkillIndex,
  type VisiblePlugin,
} from '@bastion-mcp/plugins';
import type { Infra } from '../../infra';
import { visibleReleases } from '../plugin-access';
import { createPluginServices } from '../plugin-services';

const INDEX_TTL_MS = 30 * MS.SECOND;
const MAX_INDEXES_CACHED = 5_000;
const MAX_RELEASES_CACHED = 32;

/**
 * Skills over MCP (6.8, 25.8): the Bastion-hosted skills of every marketplace the caller can see, at the release the
 * caller is served. Releases are immutable, so their parsed items are cached by `(marketplace, seq)`; the per-caller
 * index is cached for 30 s.
 */
export const createSkillsProvider = (infra: Infra): SkillsProvider => {
  const services = createPluginServices(infra);
  const items = new Map<string, Promise<ReleaseItem[]>>();
  const indexes = new TtlCache<string, SkillIndex>({
    ttlMs: INDEX_TTL_MS,
    max: MAX_INDEXES_CACHED,
    clock: infra.clock,
  });

  const releaseItems = (marketplaceId: string, seq: number): Promise<ReleaseItem[]> => {
    const key = `${marketplaceId}:${seq}`;
    let hit = items.get(key);
    if (!hit) {
      hit = services.marketplaces.loadReleaseItems(marketplaceId, seq);
      items.set(key, hit);
      hit.catch(() => items.delete(key));
      if (items.size > MAX_RELEASES_CACHED) {
        const oldest = items.keys().next().value;
        if (oldest !== undefined) items.delete(oldest);
      }
    }
    return hit;
  };

  const indexFor = async (
    principal: Parameters<SkillsProvider['list']>[0],
  ): Promise<SkillIndex> => {
    const cached = indexes.get(principal.id);
    if (cached) return cached;
    const plugins: VisiblePlugin[] = [];
    for (const release of await visibleReleases(infra, principal)) {
      for (const item of await releaseItems(release.id, release.seq)) {
        plugins.push({ marketplace: release.slug, item });
      }
    }
    const index = buildSkillIndex(plugins, services.baseUrl);
    indexes.set(principal.id, index);
    return index;
  };

  return {
    async list(principal) {
      return listSkills(await indexFor(principal));
    },
    async get(principal, ref) {
      return getSkill(await indexFor(principal), ref);
    },
    async readResource(principal, uri) {
      return readSkillResource(await indexFor(principal), uri);
    },
  };
};

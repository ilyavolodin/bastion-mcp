import { sha256Hex } from '@bastion-mcp/core';
import { PluginStateError } from './errors';
import type { Clock, MarketplaceRow, MarketplaceStore, ReleaseStore } from './ports';
import { systemClock } from './ports';
import {
  type BuiltRelease,
  buildRelease,
  buildReleaseContent,
  type ReleaseRecord,
} from './release';
import type { ReleaseItem } from './render';

const marketplaceInfo = (m: MarketplaceRow) => ({
  slug: m.slug,
  displayName: m.displayName,
  description: m.description,
  ownerName: m.ownerName,
});

/** Release times are whole seconds: the commit timestamp has second precision (25.5). */
export const releaseTimeNow = (clock: Clock): Date =>
  new Date(Math.floor(clock.now().getTime() / 1000) * 1000);

/**
 * Rebuilds a recorded release from its stored items and checks it against the record (23.2): a
 * mismatching digest means the build is not deterministic and the release must not be served.
 */
export const rebuildRelease = async (input: {
  host: string;
  marketplace: MarketplaceRow;
  record: ReleaseRecord;
  items: readonly ReleaseItem[];
  parentCommit?: string | undefined;
  gitdir?: string | undefined;
}): Promise<BuiltRelease> => {
  const built = await buildRelease(
    input.items,
    input.record.seq,
    new Date(input.record.releaseTime),
    {
      host: input.host,
      marketplace: marketplaceInfo(input.marketplace),
      parentCommit: input.parentCommit,
      gitdir: input.gitdir,
    },
  );
  const a = built.record;
  const b = input.record;
  if (
    a.gitCommit !== b.gitCommit ||
    a.claudeManifestSha256 !== b.claudeManifestSha256 ||
    a.agentsManifestSha256 !== b.agentsManifestSha256 ||
    JSON.stringify(a.archives) !== JSON.stringify(b.archives)
  ) {
    throw new PluginStateError(
      'RELEASE_NOT_REPRODUCIBLE',
      `release ${b.seq} of ${input.marketplace.slug} does not rebuild to its recorded digests`,
      500,
    );
  }
  return built;
};

export type ReleaseServiceDeps = {
  host: string;
  marketplaces: MarketplaceStore;
  releases: ReleaseStore;
  clock?: Clock;
};

/** Creates releases, rebuilds them for serving and promotes them (25.4). */
export class ReleaseService {
  private readonly cache = new Map<string, Promise<BuiltRelease>>();

  constructor(private readonly deps: ReleaseServiceDeps) {}

  private async requireMarketplace(id: string): Promise<MarketplaceRow> {
    const marketplace = await this.deps.marketplaces.getById(id);
    if (!marketplace)
      throw new PluginStateError('MARKETPLACE_NOT_FOUND', 'marketplace not found', 404);
    return marketplace;
  }

  /**
   * Creates release N+1 from the marketplace's current items. When nothing changed since the latest
   * release (same manifests and archive digests) no release is created.
   */
  async publish(
    marketplaceId: string,
    createdBy: string | null = null,
  ): Promise<{ created: boolean; record: ReleaseRecord }> {
    const marketplace = await this.requireMarketplace(marketplaceId);
    const items = await this.deps.marketplaces.resolveItems(marketplaceId);
    const latest = await this.deps.releases.latest(marketplaceId);
    const ctx = { host: this.deps.host, marketplace: marketplaceInfo(marketplace) };
    if (latest) {
      const content = buildReleaseContent(items, ctx);
      if (
        sha256Hex(content.claudeManifest) === latest.claudeManifestSha256 &&
        sha256Hex(content.agentsManifest) === latest.agentsManifestSha256 &&
        JSON.stringify(content.archiveRecord) === JSON.stringify(latest.archives)
      ) {
        return { created: false, record: latest };
      }
    }
    const seq = (latest?.seq ?? 0) + 1;
    const built = await buildRelease(items, seq, releaseTimeNow(this.deps.clock ?? systemClock), {
      ...ctx,
      parentCommit: latest?.gitCommit,
    });
    await this.deps.releases.insert(
      marketplaceId,
      built.record,
      items.map((i) => ({ entryId: i.entryId, versionId: i.versionId, policy: i.policy })),
      createdBy,
    );
    return { created: true, record: built.record };
  }

  /** Marks a release as the one pinned configurations reference (25.4, 25.7). */
  async promote(marketplaceId: string, seq: number): Promise<ReleaseRecord> {
    const record = await this.deps.releases.get(marketplaceId, seq);
    if (!record) throw new PluginStateError('RELEASE_NOT_FOUND', 'release not found', 404);
    await this.deps.marketplaces.setPromotedRelease(marketplaceId, seq);
    return record;
  }

  /** The release content for serving (manifests, archives); verified and memoized. */
  getBuilt(marketplace: MarketplaceRow, record: ReleaseRecord): Promise<BuiltRelease> {
    const key = `${marketplace.id}:${record.seq}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const promise = (async () => {
      const items = await this.deps.marketplaces.loadReleaseItems(marketplace.id, record.seq);
      const previous =
        record.seq > 1 ? await this.deps.releases.get(marketplace.id, record.seq - 1) : undefined;
      return rebuildRelease({
        host: this.deps.host,
        marketplace,
        record,
        items,
        parentCommit: previous?.gitCommit,
      });
    })();
    this.cache.set(key, promise);
    promise.catch(() => this.cache.delete(key));
    if (this.cache.size > 16) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return promise;
  }
}

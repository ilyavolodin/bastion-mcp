import { createMarketplaceStore } from '@bastion-mcp/db';
import {
  createGitBinaryProvider,
  GitRepositoryCache,
  type MarketplaceStore,
  MirrorPusher,
  ReleaseService,
  type ReleaseStore,
} from '@bastion-mcp/plugins';
import type { Infra } from '../infra';
import { assembleReleaseItem } from './plugin-content';

export type PluginServices = {
  /** Public base URL used in generated manifests (`https://host`, with the scheme the deployment really uses). */
  baseUrl: string;
  marketplaces: MarketplaceStore;
  releases: ReleaseStore;
  releaseService: ReleaseService;
  repositories: GitRepositoryCache;
  mirror: MirrorPusher;
  events: Infra['repos']['distributionEvents'];
};

const cache = new WeakMap<Infra, PluginServices>();

/**
 * One `ReleaseService` (with its built-release cache), one git repository cache and one mirror pusher per process,
 * shared by the API ports (`adapters/api/plugins.ts`) and the delivery routes (`http/ui/plugins.ts`) (25.4, 25.5).
 */
export const createPluginServices = (infra: Infra): PluginServices => {
  const hit = cache.get(infra);
  if (hit) return hit;
  const baseUrl = infra.config.publicUrl;
  const marketplaces = createMarketplaceStore(infra.db.prisma, {
    assemble: assembleReleaseItem,
    defaultOwnerName: async () => {
      const settings = await infra.repos.orgSettings.getAll();
      return settings.org.displayName;
    },
  }) as unknown as MarketplaceStore;
  const releases = infra.repos.releases as unknown as ReleaseStore;
  const releaseService = new ReleaseService({ host: baseUrl, marketplaces, releases });
  const repositories = new GitRepositoryCache({
    cacheDir: infra.config.gitCacheDir,
    host: baseUrl,
    marketplaces,
    releases,
  });
  const mirror = new MirrorPusher({
    marketplaces,
    releases,
    repositories,
    provider: createGitBinaryProvider(),
    credentials: {
      async resolve(secretId) {
        const token = await infra.secretStore.revealById(secretId);
        if (token === null) throw new Error('mirror credential is missing');
        return token;
      },
    },
  });
  const services: PluginServices = {
    baseUrl,
    marketplaces,
    releases,
    releaseService,
    repositories,
    mirror,
    events: infra.repos.distributionEvents,
  };
  cache.set(infra, services);
  return services;
};

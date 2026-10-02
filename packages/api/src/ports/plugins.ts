import type {
  MarketplaceStore,
  MirrorPusher,
  ReleaseService,
  ReleaseStore,
} from '@bastion-mcp/plugins';

export type PluginPorts = {
  marketplaces: MarketplaceStore;
  releases: ReleaseStore;
  releaseService: Pick<ReleaseService, 'publish' | 'promote'>;
  mirror: Pick<MirrorPusher, 'push'>;
  /** Distribution usage per marketplace (25.9). */
  usage(
    marketplaceId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<{
    buckets: Array<{ ts: string; channel: string; action: string; count: number }>;
  }>;
  /** Plugin source sync (25.2); the job runner owns scheduling. */
  syncSource(sourceId: string): Promise<{ imported: number; updated: number; errors: string[] }>;
  /** `host` for rollout configuration (25.7). */
  host: string;
  credentialHelperPath?: string;
};

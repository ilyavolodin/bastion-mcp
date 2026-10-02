import type { ApiDeps } from '@bastion-mcp/api';
import type { Infra } from '../../infra';
import { createPluginServices } from '../plugin-services';
import { syncPluginSource } from '../plugin-sync';

/**
 * Plugin distribution ports of the API (25.4, 25.5, 25.9): marketplaces, releases, publishing and promotion, mirror
 * pushes, usage from `distribution_events` and plugin source sync. `credentialHelperPath` is where the install page
 * tells admins to fetch the `bastion-credential` binaries from (25.6).
 */
export const createPluginApiPorts = (
  infra: Infra,
  options: { credentialHelperPath?: string } = {},
): ApiDeps['plugins'] => {
  const services = createPluginServices(infra);
  return {
    marketplaces: services.marketplaces,
    releases: services.releases,
    releaseService: services.releaseService,
    mirror: services.mirror,
    host: infra.config.publicUrl,
    ...(options.credentialHelperPath ? { credentialHelperPath: options.credentialHelperPath } : {}),
    async usage(marketplaceId, range) {
      const from = range.from ? new Date(range.from) : new Date(Date.now() - 30 * 86_400_000);
      const to = range.to ? new Date(range.to) : new Date();
      const rows = await infra.db.prisma.$queryRaw<
        { ts: Date; channel: string; action: string; count: bigint }[]
      >`
        SELECT date_trunc('day', ts) AS ts, channel, action, count(*)::bigint AS count
        FROM distribution_events
        WHERE marketplace_id = ${marketplaceId}::uuid AND ts >= ${from} AND ts < ${to}
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
      return {
        buckets: rows.map((r) => ({
          ts: r.ts.toISOString(),
          channel: r.channel,
          action: r.action,
          count: Number(r.count),
        })),
      };
    },
    syncSource: (sourceId) => syncPluginSource(infra, sourceId),
  };
};

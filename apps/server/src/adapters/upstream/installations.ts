import type { InstallationRegistry, ResolvedInstallation } from '@bastion-mcp/mcp-upstream';
import type { Infra } from '../../infra';
import { watchConfig } from '../config-watch';

const TTL_MS = 30_000;

/**
 * `InstallationRegistry` of mcp-upstream over `repos.installationRegistry` (port-matrix row), with a short cache
 * because the upstream layer asks on every call. `bastion:config` events for the installation (or any wider scope)
 * drop the entry (4.3). `notifyTargets` (6.6) come from the owner: a user installation notifies that user, a team
 * installation its team.
 */
export const createInstallationRegistry = (
  infra: Infra,
): InstallationRegistry & { watch(): () => void; invalidate(id?: string): void } => {
  const cache = new Map<string, { at: number; value: ResolvedInstallation | null }>();
  const registry = infra.repos.installationRegistry;
  if (!registry) throw new Error('installation registry is not configured (configHash missing)');

  const load = async (installationId: string): Promise<ResolvedInstallation | null> => {
    const row = await registry.get(installationId);
    if (!row) return null;
    const owner = await infra.db.prisma.installation.findUnique({
      where: { id: installationId },
      select: { ownerType: true, ownerId: true },
    });
    const notifyTargets =
      owner?.ownerType === 'team'
        ? { teamIds: [owner.ownerId] }
        : owner
          ? { principalIds: [owner.ownerId] }
          : undefined;
    return { ...row, ...(notifyTargets ? { notifyTargets } : {}) } as ResolvedInstallation;
  };

  return {
    async get(installationId) {
      const hit = cache.get(installationId);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
      const value = await load(installationId);
      cache.set(installationId, { at: Date.now(), value });
      return value;
    },
    invalidate(id) {
      if (id) cache.delete(id);
      else cache.clear();
    },
    watch() {
      return watchConfig(infra, (event) => {
        if (event.scope === 'installation' && event.id) cache.delete(event.id);
        else cache.clear();
      });
    },
  };
};

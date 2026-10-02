import type { Principal } from '@bastion-mcp/auth';
import type { Infra } from '../infra';
import { createPluginServices } from './plugin-services';

type Audience = { org?: boolean; teamIds?: string[]; userIds?: string[] };

export type ViewerLike = Pick<Principal, 'id' | 'orgRole' | 'teams'>;

/**
 * Who sees a marketplace (25.4, 25.8): admins always; otherwise the audience (`org`, listed teams, listed users) and
 * the members of the owning team.
 */
export const marketplaceVisibleTo = (
  row: { audience: unknown; ownerTeamId: string | null },
  viewer: ViewerLike,
): boolean => {
  if (viewer.orgRole === 'admin') return true;
  const audience = (row.audience ?? {}) as Audience;
  if (audience.org === true) return true;
  if (audience.userIds?.includes(viewer.id)) return true;
  const teamIds = new Set(viewer.teams.map((t) => t.teamId));
  if (audience.teamIds?.some((id) => teamIds.has(id))) return true;
  return row.ownerTeamId !== null && teamIds.has(row.ownerTeamId);
};

/** Marketplaces visible to a viewer, with the release they are served: the promoted one, else the latest (25.4). */
export const visibleReleases = async (
  infra: Infra,
  viewer: ViewerLike,
): Promise<{ id: string; slug: string; seq: number }[]> => {
  const services = createPluginServices(infra);
  const rows = await infra.db.prisma.marketplace.findMany({
    select: { id: true, slug: true, audience: true, ownerTeamId: true, promotedRelease: true },
  });
  const out: { id: string; slug: string; seq: number }[] = [];
  for (const row of rows) {
    if (!marketplaceVisibleTo(row, viewer)) continue;
    const seq = row.promotedRelease ?? (await services.releases.latest(row.id))?.seq;
    if (seq !== undefined) out.push({ id: row.id, slug: row.slug, seq });
  }
  return out;
};

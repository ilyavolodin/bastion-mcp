import type { CatalogInstallPort } from '@bastion-mcp/mcp-downstream';
import { resolveCatalogRoute } from '@bastion-mcp/plugins';
import type { Infra } from '../../infra';

type FormLike = { variables?: { required?: boolean; default?: unknown }[]; secrets?: unknown[] };

/** An entry needs setup when the install form has a required variable without default or any user secret (11.4). */
export const entryNeedsSetup = (form: unknown): boolean => {
  const f = (form ?? {}) as FormLike;
  const missingVariable = (f.variables ?? []).some(
    (v) => v.required === true && v.default === undefined,
  );
  return missingVariable || (f.secrets ?? []).length > 0;
};

const visibleTo = (
  entry: { visibility: { org: boolean; teamIds: string[]; userIds: string[] } },
  principal: { id: string; orgRole: string; teams: readonly { teamId: string }[] },
): boolean =>
  principal.orgRole === 'admin' ||
  entry.visibility.org ||
  entry.visibility.userIds.includes(principal.id) ||
  entry.visibility.teamIds.some((id) => principal.teams.some((t) => t.teamId === id));

/**
 * `/mcp/c/{catalogSlug}` (7.1, 25.8): the caller's own installation of the entry, then a team one; otherwise a
 * published entry visible to the caller gets a user installation (`origin = plugin`), in `needs_setup` when the entry
 * needs input. `created` tells the HTTP layer to drop the caller's cached endpoints.
 */
export const createCatalogInstallPort = (infra: Infra): CatalogInstallPort => ({
  async ensure(principal, catalogSlug) {
    const entry = await infra.repos.catalogEntries.getBySlug(catalogSlug);
    if (!entry || entry.status !== 'published' || entry.kind !== 'mcp_server') {
      return { status: 'not_found' };
    }
    const prisma = infra.db.prisma;
    const own = await prisma.installation.findFirst({
      where: {
        catalogEntryId: entry.id,
        ownerType: principal.type === 'service' ? 'service' : 'user',
        ownerId: principal.id,
      },
      select: { id: true, status: true },
    });
    const teamIds = principal.teams.map((t) => t.teamId);
    const team =
      teamIds.length > 0
        ? await prisma.installation.findFirst({
            where: { catalogEntryId: entry.id, ownerType: 'team', ownerId: { in: teamIds } },
            select: { id: true, status: true },
          })
        : null;
    const version = entry.currentVersionId
      ? await infra.repos.catalogVersions.get(entry.currentVersionId)
      : null;
    const route = resolveCatalogRoute({
      ...(own ? { ownInstallation: { id: own.id, state: own.status } } : {}),
      ...(team ? { teamInstallation: { id: team.id, state: team.status } } : {}),
      visible: version !== null && visibleTo(entry, principal),
      needsSetup: version ? entryNeedsSetup(version.installForm) : false,
    });
    switch (route.action) {
      case 'existing':
        return { status: 'ok', created: false };
      case 'not-visible':
        return { status: 'not_found' };
      case 'create':
      case 'needs-setup': {
        if (!version) return { status: 'not_found' };
        const base = entry.slug;
        for (let n = 1; n < 50; n += 1) {
          const slug = n === 1 ? base : `${base}-${n}`;
          const taken = await infra.repos.installations.getByOwnerSlug(
            principal.type === 'service' ? 'service' : 'user',
            principal.id,
            slug,
          );
          if (taken) continue;
          await infra.repos.installations.create({
            ownerType: principal.type === 'service' ? 'service' : 'user',
            ownerId: principal.id,
            catalogEntryId: entry.id,
            catalogVersionId: version.id,
            pinnedVersion: false,
            slug,
            displayName: entry.displayName,
            origin: 'plugin',
            status: route.action === 'needs-setup' ? 'needs_setup' : 'ready',
          });
          return { status: 'ok', created: true };
        }
        return { status: 'not_found' };
      }
    }
  },
});

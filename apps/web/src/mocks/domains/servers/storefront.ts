/** The store (11.1): the entries a person may install, and one entry's detail. */
import type { Schemas } from '@/api/schema';
import { HttpResponse, notFound, pageOf, route } from '../../http';
import { isAdmin } from '../../roles';
import { ME_ID } from '../../seed';
import { getDb } from '../../state';
import { catalog } from './store';

const ME = ME_ID;

const visibleInStore = (e: Schemas['CatalogEntry']): boolean => {
  if (e.status !== 'published') return false;
  if (isAdmin()) return true;
  const mine = getDb().me.teams.map((t) => t.id);
  return (
    e.visibility.org ||
    e.visibility.userIds.includes(ME) ||
    e.visibility.teamIds.some((t) => mine.includes(t)) ||
    (e.ownerTeamId !== null && mine.includes(e.ownerTeamId))
  );
};

const storeRow = (e: Schemas['CatalogEntry']): Schemas['StoreEntry'] => ({
  id: e.id,
  slug: e.slug,
  kind: e.kind,
  displayName: e.displayName,
  description: e.description,
  tags: e.tags,
  risk: e.risk,
  ownerTeamId: e.ownerTeamId,
  currentVersionId: e.currentVersionId,
  updatedAt: e.updatedAt,
});

export const storefrontHandlers = [
  route.get('/store', ({ url }) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const kind = url.searchParams.get('kind');
    const rows = catalog()
      .entries.filter(visibleInStore)
      .filter((e) => (kind ? e.kind === kind : true))
      .filter((e) =>
        q ? `${e.slug} ${e.displayName} ${e.description}`.toLowerCase().includes(q) : true,
      )
      .map(storeRow);
    return HttpResponse.json(pageOf(rows, url));
  }),

  route.get('/store/{slug}', ({ params }) => {
    const entry = catalog().entries.find((e) => e.slug === params.slug && visibleInStore(e));
    if (!entry) return notFound('Entry');
    const current = catalog().versions.find((v) => v.id === entry.currentVersionId);
    return HttpResponse.json({
      ...storeRow(entry),
      version: current
        ? {
            id: current.id,
            label: current.label,
            changelog: current.changelog,
            installForm: current.installForm,
            publishedAt: current.publishedAt,
          }
        : null,
    });
  }),
];

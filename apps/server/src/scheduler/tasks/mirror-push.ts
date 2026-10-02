import type { TaskFn } from '../types';

/**
 * 25.5 mirror pushes: after a release (payload `{ marketplaceId }`, enqueued by the release flow) and every five
 * minutes for every marketplace with a mirror, so failed pushes retry. `MirrorPusher` owns the backoff
 * (1, 5, 15, 60 minutes) and the `diverged` stop; a push that is not yet due returns immediately.
 */
export const mirrorPush: TaskFn<{ marketplaceId?: string } | undefined> = async (
  { infra, deps },
  payload,
) => {
  if (!deps.pushMirror) return { skipped: 'no mirror callback' };
  const ids = payload?.marketplaceId
    ? [payload.marketplaceId]
    : (
        await infra.db.prisma.marketplace.findMany({
          select: { id: true, mirror: true },
        })
      )
        .filter((m) => m.mirror !== null)
        .map((m) => m.id);
  let failed = 0;
  for (const id of ids) {
    try {
      await deps.pushMirror(id);
    } catch (error) {
      failed += 1;
      infra.logger.warn(
        { marketplaceId: id, err: error instanceof Error ? error.message : 'error' },
        'mirror push failed',
      );
    }
  }
  return { marketplaces: ids.length, failed };
};

import { ConflictApiError, NotFoundApiError } from '../errors';
import type { Row } from '../ports/store';
import { CrudService, nowIso, type WriteCtx } from './crud';

export const driftReviews = new CrudService({
  collection: 'drift_reviews',
  targetType: 'drift_review',
  action: 'drift_review',
  configTopic: 'pins',
});

const pinId = (review: Row): string => {
  const scope = String(review.installationId ?? review.catalogVersionId ?? 'global');
  return `${scope}:${String(review.itemKind)}:${String(review.itemKey)}`;
};

const loadOpen = async (ctx: WriteCtx, id: string): Promise<Row> => {
  const review = await ctx.tx.store.get('drift_reviews', id);
  if (!review) throw new NotFoundApiError('drift review');
  if (review.status !== 'open') {
    throw new ConflictApiError(`the review is already ${String(review.status)}`, 'review_closed');
  }
  return review;
};

const notify = (ctx: WriteCtx, review: Row, status: string): void => {
  ctx.tx.emit({
    id: ctx.deps.newId(),
    type: 'drift.review',
    audience: { org: true },
    data: { reviewId: review.id, status, itemKind: review.itemKind, itemKey: review.itemKey },
    topic: String(review.installationId ?? review.catalogVersionId ?? ''),
  });
};

/** Approving moves the pin to the new definition so the item is served again (13.6). */
export const approveReview = async (ctx: WriteCtx, id: string, note?: string): Promise<Row> => {
  const review = await loadOpen(ctx, id);
  const decidedAt = nowIso(ctx.deps);
  const updated = await ctx.tx.store.update('drift_reviews', id, {
    status: 'approved',
    decidedBy: ctx.principal.id,
    decidedAt,
    reason: note ?? null,
  });
  await ctx.tx.store.upsert('definition_pins', pinId(review), {
    installationId: review.installationId ?? null,
    catalogVersionId: review.catalogVersionId ?? null,
    itemKind: review.itemKind,
    itemKey: review.itemKey,
    hash: review.newHash,
    definition: review.newDefinition,
    approvedBy: ctx.principal.id,
    approvedAt: decidedAt,
  });
  await ctx.tx.audit({
    action: 'drift_review.approve',
    targetType: 'drift_review',
    targetId: id,
    diff: { itemKind: review.itemKind, itemKey: review.itemKey, newHash: review.newHash },
  });
  ctx.tx.configChanged('pins');
  notify(ctx, review, 'approved');
  return updated;
};

/** Rejecting keeps the old pin; the changed item stays hidden or blocked per the drift policy (13.6). */
export const rejectReview = async (ctx: WriteCtx, id: string, reason: string): Promise<Row> => {
  const review = await loadOpen(ctx, id);
  const updated = await ctx.tx.store.update('drift_reviews', id, {
    status: 'rejected',
    decidedBy: ctx.principal.id,
    decidedAt: nowIso(ctx.deps),
    reason,
  });
  await ctx.tx.audit({
    action: 'drift_review.reject',
    targetType: 'drift_review',
    targetId: id,
    diff: { itemKind: review.itemKind, itemKey: review.itemKey, reason },
  });
  notify(ctx, review, 'rejected');
  return updated;
};

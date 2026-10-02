import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const ids = (v: unknown): string[] => (rec(v).items as { id: string }[]).map((i) => i.id);

describe('13.6 drift reviews', () => {
  it('13.6 lists reviews and filters by status and installation', async () => {
    api = await buildTestApi();
    const all = await api.call('admin', 'GET', '/drift-reviews');
    expect(ids(all.body)).toEqual(['drift-1', 'drift-2']);
    await api.store.update('drift_reviews', 'drift-2', { status: 'approved' });
    const open = await api.call('auditor', 'GET', '/drift-reviews', { query: { status: 'open' } });
    expect(ids(open.body)).toEqual(['drift-1']);
    const none = await api.call('admin', 'GET', '/drift-reviews', {
      query: { installationId: 'x' },
    });
    expect(ids(none.body)).toEqual([]);
  });

  it('13.6 approving stores the new pin, closes the review and notifies after commit', async () => {
    api = await buildTestApi();
    const res = await api.call('admin', 'POST', '/drift-reviews/drift-1/approve', {
      body: { note: 'looks fine' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      decidedBy: 'user-admin',
      reason: 'looks fine',
    });
    const pin = await api.store.get('definition_pins', 'inst-team-a:tool:search');
    expect(pin).toMatchObject({ hash: 'sha-new', approvedBy: 'user-admin', itemKey: 'search' });
    expect(api.uow.audits.at(-1)).toMatchObject({
      action: 'drift_review.approve',
      targetId: 'drift-1',
    });
    expect(api.publisher.messages.at(-1)?.message).toBe('{"topic":"pins"}');
    expect(api.events.published.at(-1)).toMatchObject({
      type: 'drift.review',
      data: { reviewId: 'drift-1', status: 'approved' },
    });
  });

  it('13.6 rejecting needs a reason, keeps the old pin and closes the review', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('admin', 'POST', '/drift-reviews/drift-1/reject', { body: {} })).status,
    ).toBe(400);
    const res = await api.call('admin', 'POST', '/drift-reviews/drift-1/reject', {
      body: { reason: 'suspicious' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', reason: 'suspicious' });
    expect(await api.store.get('definition_pins', 'inst-team-a:tool:search')).toBeNull();
    expect(api.events.published.at(-1)).toMatchObject({ data: { status: 'rejected' } });
  });

  it('13.6 a closed review cannot be decided twice; unknown reviews are 404', async () => {
    api = await buildTestApi();
    await api.call('admin', 'POST', '/drift-reviews/drift-1/approve', { body: {} });
    const again = await api.call('admin', 'POST', '/drift-reviews/drift-1/reject', {
      body: { reason: 'x' },
    });
    expect(again.status).toBe(409);
    expect(rec(again.body).code).toBe('review_closed');
    expect(
      (await api.call('admin', 'POST', '/drift-reviews/nope/approve', { body: {} })).status,
    ).toBe(404);
  });

  it('10.1 only admins decide (managers, members and auditors get 403)', async () => {
    api = await buildTestApi();
    for (const actor of ['managerOwn', 'member', 'auditor'] as const) {
      expect(
        (await api.call(actor, 'POST', '/drift-reviews/drift-1/approve', { body: {} })).status,
      ).toBe(403);
    }
  });
});

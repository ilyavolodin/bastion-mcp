import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApi, type TestApi } from './helpers/harness';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const items = (v: unknown): Record<string, unknown>[] => rec(v).items as Record<string, unknown>[];

const seedRequests = async (t: TestApi) => {
  const rows: [string, string, string][] = [
    ['r1', 'user-member-b', '2026-06-05T00:00:00.000Z'],
    ['r2', 'user-member-a', '2026-06-04T00:00:00.000Z'],
    ['r3', 'user-manager-a', '2026-06-03T00:00:00.000Z'],
    ['r4', 'user-member-a', '2026-06-02T00:00:00.000Z'],
    ['r5', 'user-member-a', '2026-06-01T00:00:00.000Z'],
  ];
  for (const [id, requesterId, createdAt] of rows) {
    await t.store.seed('install_requests', {
      id,
      requesterId,
      sourceId: 'src-official',
      serverName: 'io.github.acme/remote-docs',
      version: '1.0.0',
      justification: id,
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      reason: null,
      createdAt,
    });
  }
};

const page = async (t: TestApi, query: Record<string, string>) => {
  const res = await t.call('managerOwn', 'GET', '/install-requests', { query });
  expect(res.status).toBe(200);
  return { ids: items(res.body).map((i) => i.id), nextCursor: rec(res.body).nextCursor };
};

describe('11.7 manager request pages', () => {
  it('11.7 a manager sees own and team members requests; foreign rows drop out of the page', async () => {
    api = await buildTestApi();
    await seedRequests(api);
    const all = await page(api, { limit: '10' });
    expect(all.ids).toEqual(['r2', 'r3', 'r4', 'req-1', 'r5']);
  });

  it('11.7 a short page keeps a non-null cursor and the next page continues after it', async () => {
    api = await buildTestApi();
    await seedRequests(api);
    const first = await page(api, { limit: '2' });
    expect(first.ids).toEqual(['r2']);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(api, { limit: '2', cursor: String(first.nextCursor) });
    expect(second.ids).toEqual(['r3', 'r4']);
    expect(second.nextCursor).not.toBeNull();
    const third = await page(api, { limit: '2', cursor: String(second.nextCursor) });
    expect(third.ids).toEqual(['req-1', 'r5']);
    expect(third.nextCursor).toBeNull();
  });

  it('11.7 a page of only foreign rows is empty with a non-null cursor', async () => {
    api = await buildTestApi();
    await seedRequests(api);
    const first = await page(api, { limit: '1' });
    expect(first.ids).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
  });
});

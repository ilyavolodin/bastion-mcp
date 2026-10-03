import { describe, expect, it } from 'vitest';
import type { ListQuery, Row } from '../src/ports/store';
import { visiblePage } from '../src/services/catalog';

type Ctx = Parameters<typeof visiblePage>[0];
const rows: Row[] = Array.from({ length: 9 }, (_, i) => ({
  id: `r${i}`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  visible: i % 3 !== 0,
}));

/** Cursor-paged fake store honouring `limit`, like the real one. */
const ctxOver = (all: Row[]) => ({
  deps: {
    store: {
      list: async (_c: string, q: ListQuery) => {
        const start = q.cursor ? Number(q.cursor) : 0;
        const items = all.slice(start, start + q.limit);
        const end = start + items.length;
        return { items, nextCursor: end < all.length ? String(end) : null };
      },
    },
  },
});

describe('11.1 visiblePage', () => {
  it('11.1 never drops rows on a page that straddles the limit', async () => {
    const ctx = ctxOver(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await visiblePage(
        ctx as unknown as Ctx,
        'catalog_entries',
        { limit: 3, cursor },
        {},
        (r) => r.visible === true,
      );
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(rows.filter((r) => r.visible).map((r) => r.id));
  });
});

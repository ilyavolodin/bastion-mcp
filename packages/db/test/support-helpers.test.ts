import { describe, expect, it } from 'vitest';
import {
  encodeCursor,
  etagOf,
  idCursorOf,
  NotFoundError,
  PreconditionFailedError,
  PreconditionRequiredError,
  paginate,
  versionedUpdate,
} from '../src/repositories/support';

const row = (updatedAt: Date | null = null) => ({ id: 'a', createdAt: new Date(1000), updatedAt });

describe('paginate', () => {
  it('17.1 asks for limit + 1 rows, cuts the page and maps the items', async () => {
    const taken: number[] = [];
    const rows = [{ id: '3' }, { id: '2' }, { id: '1' }];
    const page = await paginate(
      { limit: 2 },
      async (take) => {
        taken.push(take);
        return rows.slice(0, take);
      },
      idCursorOf,
      (r) => r.id,
    );
    expect(taken).toEqual([3]);
    expect(page).toEqual({ items: ['3', '2'], nextCursor: encodeCursor(['2']) });
  });

  it('17.1 has no next cursor on the last page', async () => {
    const page = await paginate(
      { limit: 5 },
      async () => [{ id: '1' }],
      idCursorOf,
      (r) => r.id,
    );
    expect(page).toEqual({ items: ['1'], nextCursor: null });
  });
});

describe('versionedUpdate', () => {
  const base = row();
  const spec = (over: Partial<Parameters<typeof versionedUpdate<typeof base>>[0]> = {}) => ({
    what: 'thing',
    id: 'a',
    ifMatch: etagOf(base),
    find: async () => base as typeof base | null,
    write: async () => ({ count: 1 }),
    reload: async () => ({ ...base, updatedAt: new Date(5000) }),
    ...over,
  });

  it('17.1 throws 404 when the row is missing', async () => {
    await expect(versionedUpdate(spec({ find: async () => null }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('17.1 throws 428 without If-Match and 412 for a stale one', async () => {
    await expect(versionedUpdate(spec({ ifMatch: undefined }))).rejects.toBeInstanceOf(
      PreconditionRequiredError,
    );
    await expect(versionedUpdate(spec({ ifMatch: '"zzz"' }))).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('17.1 throws 412 when the compare-and-swap loses and never reloads', async () => {
    let reloaded = false;
    await expect(
      versionedUpdate(
        spec({
          write: async () => ({ count: 0 }),
          reload: async () => {
            reloaded = true;
            return base;
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(reloaded).toBe(false);
  });

  it('17.1 guards the write with the version, bumps updatedAt past it, then runs afterSwap and reloads', async () => {
    const calls: string[] = [];
    const result = await versionedUpdate(
      spec({
        write: async (_current, where, updatedAt) => {
          calls.push('write');
          expect(where).toEqual({ id: 'a', updatedAt: null });
          expect(updatedAt.getTime()).toBeGreaterThan(base.createdAt.getTime());
          return { count: 1 };
        },
        afterSwap: async () => {
          calls.push('afterSwap');
        },
      }),
      new Date(0),
    );
    expect(calls).toEqual(['write', 'afterSwap']);
    expect(result.current).toBe(base);
    expect(result.row.updatedAt).toEqual(new Date(5000));
  });
});

import {
  ConflictApiError,
  encodeOffset,
  NotFoundApiError,
  ValidationApiError,
} from '@bastion-mcp/api';
import { Prisma } from '@bastion-mcp/db';
import { describe, expect, it } from 'vitest';
import { createResourceStore } from '../src/adapters/api/resource-store';
import {
  type AnyDelegate,
  createCollection,
  type DbRow,
  deriveUuid,
  hexOf,
  type StoreContext,
  toDbValue,
  translateError,
  versionOf,
} from '../src/adapters/api/store/collection';
import type { FieldMeta, StoreMeta } from '../src/adapters/api/store/meta';

const field = (over: Partial<FieldMeta> & { name: string }): FieldMeta => ({
  type: 'String',
  column: over.name,
  uuid: false,
  nullable: false,
  array: false,
  ...over,
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('16.2 value conversion', () => {
  it('hexOf prints bytes as lowercase hex', () => {
    expect(hexOf(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('deriveUuid is stable, distinct per id and shaped like a version 5 UUID', () => {
    expect(deriveUuid('a:b')).toBe(deriveUuid('a:b'));
    expect(deriveUuid('a:b')).not.toBe(deriveUuid('a:c'));
    expect(deriveUuid('a:b')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('toDbValue converts dates, integers, bytes and rejects wrong types', () => {
    expect(toDbValue(field({ name: 'at', type: 'DateTime' }), '2026-01-01T00:00:00Z')).toEqual(
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(() => toDbValue(field({ name: 'at', type: 'DateTime' }), 'nope')).toThrow(
      ValidationApiError,
    );
    expect(toDbValue(field({ name: 'n', type: 'BigInt' }), '12')).toBe(12n);
    expect(() => toDbValue(field({ name: 'n', type: 'BigInt' }), 'x')).toThrow(ValidationApiError);
    expect(toDbValue(field({ name: 'b', type: 'Bytes' }), 'ff00')).toEqual(
      new Uint8Array([255, 0]),
    );
    expect(() => toDbValue(field({ name: 'b', type: 'Bytes' }), 'zz')).toThrow(ValidationApiError);
    expect(() => toDbValue(field({ name: 'n', type: 'Int' }), '1')).toThrow(ValidationApiError);
    expect(() => toDbValue(field({ name: 'f', type: 'Boolean' }), 1)).toThrow(ValidationApiError);
  });

  it('toDbValue checks uuids and arrays and maps null on Json columns', () => {
    expect(() => toDbValue(field({ name: 'id', uuid: true }), 'not-a-uuid')).toThrow(
      ValidationApiError,
    );
    expect(toDbValue(field({ name: 'id', uuid: true }), UUID_A)).toBe(UUID_A);
    expect(() => toDbValue(field({ name: 'ids', uuid: true, array: true }), [UUID_A, 'x'])).toThrow(
      ValidationApiError,
    );
    expect(() => toDbValue(field({ name: 'ids', array: true }), 'x')).toThrow(ValidationApiError);
    expect(toDbValue(field({ name: 'j', type: 'Json', nullable: true }), null)).toBe(Prisma.DbNull);
    expect(toDbValue(field({ name: 'j', type: 'Json' }), null)).toBe(Prisma.JsonNull);
    expect(toDbValue(field({ name: 's' }), null)).toBeNull();
  });

  it('versionOf picks the first timestamp the row has, else the epoch', () => {
    const t = new Date('2026-02-02T00:00:00Z');
    expect(versionOf({ createdAt: new Date(1), updatedAt: t })).toBe(t);
    expect(versionOf({ ts: t })).toBe(t);
    expect(versionOf({}).getTime()).toBe(0);
  });
});

describe('16.2 translateError', () => {
  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

  it('maps unique, foreign key and missing-row failures to API errors', () => {
    expect(() => translateError(known('P2002'), 'team')).toThrow(ConflictApiError);
    expect(() => translateError(known('P2003'), 'team')).toThrow(/references or is referenced/);
    expect(() => translateError(known('P2025'), 'team')).toThrow(NotFoundApiError);
  });

  it('rethrows anything else untouched', () => {
    const boom = new Error('boom');
    expect(() => translateError(boom, 'team')).toThrow(boom);
    expect(() => translateError(known('P9999'), 'team')).toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});

describe('16.2 generic collection over a fake delegate', () => {
  const meta: StoreMeta = {
    models: new Map([
      [
        'Thing',
        {
          model: 'Thing',
          delegate: 'thing',
          table: 'things',
          fields: new Map(
            [
              field({ name: 'id', uuid: true }),
              field({ name: 'name' }),
              field({ name: 'secret' }),
              field({ name: 'createdAt', type: 'DateTime' }),
              field({ name: 'updatedAt', type: 'DateTime', nullable: true }),
            ].map((f) => [f.name, f]),
          ),
        },
      ],
    ]),
  };

  const harness = (rows: DbRow[] = []) => {
    const calls: { op: string; args: unknown }[] = [];
    const delegate: AnyDelegate = {
      findMany: async (args) => {
        calls.push({ op: 'findMany', args });
        return rows;
      },
      findFirst: async (args) => {
        calls.push({ op: 'findFirst', args });
        return rows[0] ?? null;
      },
      create: async (args) => {
        calls.push({ op: 'create', args });
        return { ...(args as { data: DbRow }).data, createdAt: new Date(5_000), updatedAt: null };
      },
      updateMany: async (args) => {
        calls.push({ op: 'updateMany', args });
        return { count: 1 };
      },
      deleteMany: async (args) => {
        calls.push({ op: 'deleteMany', args });
        return { count: rows.length };
      },
    };
    const ctx: StoreContext = {
      db: { thing: delegate } as never,
      meta,
      newId: () => UUID_B,
    };
    const store = createCollection(ctx, { collection: 'teams', model: 'Thing', hide: ['secret'] });
    return { store, calls };
  };

  const stored = (): DbRow => ({
    id: UUID_A,
    name: 'alpha',
    secret: 'hunter2',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  });

  it('rejects an unknown model at construction', () => {
    expect(() =>
      createCollection(
        { db: {} as never, meta, newId: () => UUID_A },
        { collection: 'teams', model: 'Nope' },
      ),
    ).toThrow('unknown model Nope');
  });

  it('get hides columns, stringifies dates and adds id and updatedAt', async () => {
    const { store } = harness([stored()]);
    expect(await store.get(UUID_A)).toEqual({
      id: UUID_A,
      name: 'alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('get of an id that cannot be a uuid is a miss without touching the database', async () => {
    const { store, calls } = harness([stored()]);
    expect(await store.get('not-a-uuid')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('list pages by offset: asks for one extra row and returns the next cursor', async () => {
    const { store, calls } = harness([stored(), { ...stored(), id: UUID_B }]);
    const page = await store.list({ limit: 1, cursor: encodeOffset(10) } as never);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(encodeOffset(11));
    expect(calls[0]).toMatchObject({ op: 'findMany', args: { skip: 10, take: 2 } });
  });

  it('list with a filter on an unknown or hidden column returns nothing', async () => {
    const { store, calls } = harness([stored()]);
    expect((await store.list({ limit: 5, where: { bogus: 1 } } as never)).items).toEqual([]);
    expect((await store.list({ limit: 5, where: { secret: 'x' } } as never)).items).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('insert generates the id, coerces columns and drops unknown keys', async () => {
    const { store, calls } = harness();
    const row = await store.insert({ name: 'beta', bogus: 1 });
    expect(calls[0]).toEqual({ op: 'create', args: { data: { name: 'beta', id: UUID_B } } });
    expect(row.id).toBe(UUID_B);
  });

  it('update of a missing row is a 404 and of an existing row bumps updatedAt past the old version', async () => {
    const missing = harness();
    await expect(missing.store.update(UUID_A, { name: 'x' })).rejects.toThrow(NotFoundApiError);
    const { store, calls } = harness([stored()]);
    await store.update(UUID_A, { name: 'gamma', id: UUID_B });
    const write = calls.find((c) => c.op === 'updateMany')?.args as {
      data: { name: string; updatedAt: Date; id?: string };
    };
    expect(write.data.name).toBe('gamma');
    expect(write.data.id).toBeUndefined();
    expect(write.data.updatedAt.getTime()).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'));
  });

  it('remove reports whether a row went away', async () => {
    expect(await harness([stored()]).store.remove(UUID_A)).toBe(true);
    expect(await harness().store.remove(UUID_A)).toBe(false);
  });
});

describe('16.2 createResourceStore', () => {
  it('maps every collection the API declares and fails on one that is not mapped', () => {
    const store = createResourceStore({} as never, { models: new Map() });
    expect(typeof store.list).toBe('function');
    expect(() => store.get('no_such_collection' as never, 'x')).toThrow(
      'collection no_such_collection is not mapped',
    );
  });
});

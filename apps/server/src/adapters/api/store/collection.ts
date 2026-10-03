/**
 * The generic table-backed collection: one `CollectionSpec` describes how an API collection maps onto a Prisma model
 * (key columns, hidden columns, search columns, virtual fields, config-version scope). Everything else (type
 * coercion, filters, offset pagination, ETag versions, error translation) is shared here.
 */

import { createHash } from 'node:crypto';
import {
  type Collection,
  ConflictApiError,
  decodeOffset,
  encodeOffset,
  type ListQuery,
  NotFoundApiError,
  type Page,
  type Row,
  ValidationApiError,
} from '@bastion-mcp/api';
import {
  bumpConfigVersion,
  NIL_UUID,
  nextUpdatedAt,
  Prisma,
  type PrismaClient,
  type UnitState,
} from '@bastion-mcp/db';
import { type FieldMeta, isUuid, type ModelMeta, type StoreMeta } from './meta';

export type DbRow = Record<string, unknown>;
type Where = Record<string, unknown>;

export type AnyDelegate = {
  findMany(args?: object): Promise<DbRow[]>;
  findFirst(args?: object): Promise<DbRow | null>;
  create(args: object): Promise<DbRow>;
  updateMany(args: object): Promise<{ count: number }>;
  deleteMany(args: object): Promise<{ count: number }>;
};

/** Anything that behaves like a Prisma client for model access (the client or a transaction client). */
export type Db = PrismaClient | Prisma.TransactionClient;

export type StoreContext = {
  db: Db;
  meta: StoreMeta;
  unit?: UnitState | undefined;
  newId: () => string;
};

/** One API collection, whatever it is stored in. */
export interface CollectionStore {
  list(query: ListQuery): Promise<Page<Row>>;
  get(id: string): Promise<Row | null>;
  find(where: Record<string, unknown>): Promise<Row[]>;
  insert(data: Record<string, unknown> & { id?: string }): Promise<Row>;
  update(id: string, patch: Record<string, unknown>): Promise<Row>;
  upsert(id: string, data: Record<string, unknown>): Promise<Row>;
  remove(id: string): Promise<boolean>;
}

export type ConfigScope = 'org' | 'user' | 'team' | 'installation' | 'catalog' | 'endpoint';

export type CollectionSpec = {
  collection: Collection;
  /** Prisma model name. */
  model: string;
  /** Key columns; one column is the row `id`, several are joined with `:` (`teamId:userId`). Default `['id']`. */
  key?: string[];
  /** Derive a deterministic UUID from non-UUID ids (definition pins use `<scope>:<kind>:<key>` ids). */
  deriveId?: boolean;
  /** Columns that never leave the store. */
  hide?: string[];
  /** Text columns searched by `q` (case-insensitive contains). */
  search?: string[];
  order?: Record<string, 'asc' | 'desc'>[];
  /** Which config version to bump after a write (4.3); `null` when the data does not affect endpoints. */
  bump?: (row: DbRow) => [ConfigScope, string] | null;
  /** Adds API-only fields to a converted row. */
  decorate?: (dbRow: DbRow, row: Record<string, unknown>) => void | Promise<void>;
  /** Rewrites API data into column data (virtual fields, renamed columns). May consult the existing row. */
  mapIn?: (
    data: Record<string, unknown>,
    existing: DbRow | null,
    ctx: StoreContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** API filter fields that are not columns. */
  virtualWhere?: Record<string, (value: unknown) => Where>;
  afterWrite?: (ctx: StoreContext, row: DbRow) => Promise<void>;
  /** Runs in the same transaction before a row is deleted: removes data no foreign key cascades to (or refuses). */
  beforeRemove?: (ctx: StoreContext, row: DbRow) => Promise<void>;
  /** Columns omitted from API rows when null (the API schema treats them as absent, not null). */
  omitNull?: string[];
  /** Column values for inserts that do not carry them (the API leaves some NOT NULL audit columns to the caller). */
  defaults?: Record<string, unknown>;
  /** Extra Prisma `findMany` options, for example an `include` to decorate rows. */
  include?: object;
};

const EPOCH = new Date(0);

export const hexOf = (value: unknown): string => Buffer.from(value as Uint8Array).toString('hex');

/** `a:b:c` style ids built from key columns. */
const joinKey = (fields: readonly string[], row: DbRow): string =>
  fields.map((f) => String(row[f])).join(':');

const splitKey = (fields: readonly string[], id: string): string[] | null => {
  if (fields.length === 1) return [id];
  const parts: string[] = [];
  let rest = id;
  for (let i = 0; i < fields.length - 1; i += 1) {
    const at = rest.indexOf(':');
    if (at < 0) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
};

/** A stable UUID for a non-UUID id (SHA-256 shaped as a version 5 UUID). */
export const deriveUuid = (id: string): string => {
  const h = createHash('sha256').update(`bastion-resource:${id}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// --- value conversion -------------------------------------------------------------------------------------------

const toApiValue = (field: FieldMeta | undefined, value: unknown): unknown => {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint')
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return hexOf(value);
  if (
    field?.type === 'Decimal' &&
    typeof (value as { toString?: unknown }).toString === 'function'
  ) {
    return Number(String(value));
  }
  return value;
};

const invalid = (path: string, message: string): ValidationApiError =>
  new ValidationApiError(`invalid value for ${path}`, [{ path: `/${path}`, message }]);

/** Converts an API value into what Prisma accepts for the column. Throws a validation error for bad input. */
export const toDbValue = (field: FieldMeta, value: unknown): unknown => {
  if (value === null) {
    if (field.type === 'Json') return field.nullable ? Prisma.DbNull : Prisma.JsonNull;
    return null;
  }
  if (field.array) {
    if (!Array.isArray(value)) throw invalid(field.name, 'expected an array');
    if (field.uuid && !value.every(isUuid)) throw invalid(field.name, 'expected UUIDs');
    return value;
  }
  switch (field.type) {
    case 'DateTime': {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) throw invalid(field.name, 'expected a date-time');
      return d;
    }
    case 'BigInt':
      try {
        return BigInt(value as string | number);
      } catch {
        throw invalid(field.name, 'expected an integer');
      }
    case 'Bytes': {
      if (value instanceof Uint8Array) return new Uint8Array(value);
      if (typeof value === 'string' && /^([0-9a-f]{2})*$/i.test(value)) {
        return new Uint8Array(Buffer.from(value, 'hex'));
      }
      throw invalid(field.name, 'expected hex bytes');
    }
    case 'Int':
    case 'Float':
      if (typeof value !== 'number' || Number.isNaN(value))
        throw invalid(field.name, 'expected a number');
      return value;
    case 'Boolean':
      if (typeof value !== 'boolean') throw invalid(field.name, 'expected a boolean');
      return value;
    case 'String':
      if (typeof value !== 'string') throw invalid(field.name, 'expected a string');
      if (field.uuid && !isUuid(value)) throw invalid(field.name, 'expected a UUID');
      return value;
    default:
      return value;
  }
};

/** Translates Prisma and Postgres failures into API errors. */
export const translateError = (error: unknown, what: string): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new ConflictApiError(`${what} already exists`);
    if (error.code === 'P2003')
      throw new ConflictApiError(`${what} references or is referenced by another resource`, {
        code: 'conflict',
      });
    if (error.code === 'P2025') throw new NotFoundApiError(what);
  }
  throw error;
};

// --- the generic collection -----------------------------------------------------------------------------------------

export const delegateOf = (ctx: StoreContext, model: ModelMeta): AnyDelegate =>
  (ctx.db as unknown as Record<string, AnyDelegate>)[model.delegate] as AnyDelegate;

export const versionOf = (row: DbRow): Date => {
  for (const f of ['updatedAt', 'createdAt', 'approvedAt', 'appliedAt', 'ts'] as const) {
    const v = row[f];
    if (v instanceof Date) return v;
  }
  return EPOCH;
};

export const createCollection = (ctx: StoreContext, spec: CollectionSpec): CollectionStore => {
  const model = ctx.meta.models.get(spec.model);
  if (!model) throw new Error(`unknown model ${spec.model}`);
  const delegate = delegateOf(ctx, model);
  const key = spec.key ?? ['id'];
  const hidden = new Set(spec.hide ?? []);
  const label = spec.collection.replaceAll('_', ' ');
  const hasUpdatedAt = model.fields.has('updatedAt');

  const idToDb = (id: string): string[] | null => {
    const parts = splitKey(key, id);
    if (!parts) return null;
    return parts.map((p, i) => {
      const f = model.fields.get(key[i] ?? '');
      if (spec.deriveId && f?.uuid && !isUuid(p)) return deriveUuid(id);
      return p;
    });
  };

  /** `where` for a row id, or null when the id cannot name a row (so `get` is simply a miss). */
  const whereId = (id: string): Where | null => {
    const parts = idToDb(id);
    if (!parts) return null;
    const out: Where = {};
    for (let i = 0; i < key.length; i += 1) {
      const name = key[i] as string;
      const f = model.fields.get(name);
      const part = parts[i] as string;
      if (f?.uuid && !isUuid(part)) return null;
      out[name] = part;
    }
    return out;
  };

  const toRow = async (db: DbRow): Promise<Row> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(db)) {
      if (hidden.has(name) || name === 'search') continue;
      out[name] = toApiValue(model.fields.get(name), value);
    }
    for (const name of spec.omitNull ?? []) if (out[name] === null) delete out[name];
    out.id = joinKey(key, db);
    out.updatedAt = versionOf(db).toISOString();
    await spec.decorate?.(db, out);
    return out as Row;
  };

  /** Column values for a write: unknown keys (virtual or foreign) are dropped, the rest coerced. */
  const columns = (data: Record<string, unknown>, forUpdate: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(data)) {
      if (value === undefined || name === 'updatedAt') continue;
      const f = model.fields.get(name);
      if (!f) continue;
      if (forUpdate && key.includes(name)) continue;
      out[name] = toDbValue(f, value);
    }
    return out;
  };

  const bump = async (row: DbRow): Promise<void> => {
    const target = spec.bump?.(row);
    if (!target) return;
    if (ctx.unit) ctx.unit.bump(target[0], target[1]);
    else {
      await bumpConfigVersion(ctx.db as never, target[0], target[1]);
    }
  };

  const toWhere = (filter: Record<string, unknown> | undefined): Where | null => {
    const and: Where[] = [];
    for (const [name, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      if (name === 'id') {
        const w = whereId(String(value));
        if (!w) return null;
        and.push(w);
        continue;
      }
      const virtual = spec.virtualWhere?.[name];
      if (virtual) {
        and.push(virtual(value));
        continue;
      }
      const f = model.fields.get(name);
      if (!f || hidden.has(name)) return null;
      if (value === null) {
        and.push({ [name]: null });
        continue;
      }
      if (f.uuid && !f.array && !isUuid(value)) return null;
      if (f.type === 'Json') return null;
      try {
        const v = toDbValue(f, value);
        and.push({ [name]: f.array ? { has: Array.isArray(v) ? v[0] : v } : v });
      } catch {
        return null;
      }
    }
    return and.length === 0 ? {} : { AND: and };
  };

  const orderBy = (sort: ListQuery['sort']): Record<string, 'asc' | 'desc'>[] => {
    const base = spec.order ?? key.map((k) => ({ [k]: 'asc' as const }));
    const f = sort ? model.fields.get(sort.field) : undefined;
    if (sort && f && !hidden.has(sort.field) && f.type !== 'Json') {
      return [
        { [sort.field]: sort.desc ? 'desc' : 'asc' },
        ...base.filter((o) => !(sort.field in o)),
      ];
    }
    return base;
  };

  const readOne = async (where: Where): Promise<DbRow | null> =>
    delegate.findFirst({ where, ...(spec.include ?? {}) });

  const withWrite = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      return translateError(error, label);
    }
  };

  const insertRow = async (data: Record<string, unknown> & { id?: string }): Promise<Row> => {
    const mapped = spec.mapIn ? await spec.mapIn({ ...data }, null, ctx) : { ...data };
    // The row id is resolved below (it may be derived or composite), never coerced as a plain column.
    if (key.length === 1 && key[0] === 'id') delete mapped.id;
    for (const [name, value] of Object.entries(spec.defaults ?? {})) {
      if (mapped[name] === undefined) mapped[name] = value;
    }
    const values = columns(mapped, false);
    // The key: `id` for single-column keys, otherwise the parts of a composite id or the named columns.
    if (key.length === 1) {
      const k = key[0] as string;
      if (values[k] === undefined) {
        const given = data.id ?? (k === 'id' ? ctx.newId() : undefined);
        if (given === undefined) throw invalid(k, 'is required');
        const part = idToDb(String(given))?.[0];
        if (part !== undefined) values[k] = part;
      }
    } else if (data.id !== undefined) {
      const parts = idToDb(String(data.id));
      key.forEach((k, i) => {
        if (values[k] === undefined && parts?.[i] !== undefined) values[k] = parts[i];
      });
    }
    const created = await withWrite(() => delegate.create({ data: values }));
    await spec.afterWrite?.(ctx, created);
    await bump(created);
    return toRow(created);
  };

  const updateRow = async (id: string, patch: Record<string, unknown>): Promise<Row> => {
    const where = whereId(id);
    const existing = where ? await readOne(where) : null;
    if (!where || !existing) throw new NotFoundApiError(label);
    const mapped = spec.mapIn ? await spec.mapIn({ ...patch }, existing, ctx) : { ...patch };
    const data = columns(mapped, true);
    if (hasUpdatedAt) {
      data.updatedAt = nextUpdatedAt({
        createdAt: (existing.createdAt as Date | undefined) ?? EPOCH,
        updatedAt: (existing.updatedAt as Date | null | undefined) ?? null,
      });
    }
    if (Object.keys(data).length > 0) {
      await withWrite(() => delegate.updateMany({ where, data }));
    }
    const fresh = (await readOne(where)) as DbRow;
    await spec.afterWrite?.(ctx, fresh);
    await bump(fresh);
    return toRow(fresh);
  };

  return {
    async list(query) {
      const where = toWhere(query.where);
      if (!where) return { items: [], nextCursor: null };
      const and: Where[] = [where];
      if (query.q && spec.search?.length) {
        and.push({
          OR: spec.search.map((f) => ({ [f]: { contains: query.q, mode: 'insensitive' } })),
        });
      }
      const offset = decodeOffset(query.cursor);
      const rows = await delegate.findMany({
        where: { AND: and },
        orderBy: orderBy(query.sort),
        skip: offset,
        take: query.limit + 1,
        ...(spec.include ?? {}),
      });
      const page = rows.slice(0, query.limit);
      return {
        items: await Promise.all(page.map(toRow)),
        nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
      };
    },

    async get(id) {
      const where = whereId(id);
      const row = where ? await readOne(where) : null;
      return row ? toRow(row) : null;
    },

    async find(filter) {
      const where = toWhere(filter);
      if (!where) return [];
      const rows = await delegate.findMany({
        where,
        orderBy: orderBy(undefined),
        ...(spec.include ?? {}),
      });
      return Promise.all(rows.map(toRow));
    },

    insert: insertRow,
    update: updateRow,

    async upsert(id, data) {
      const where = whereId(id);
      const existing = where ? await readOne(where) : null;
      if (existing) return updateRow(id, data);
      return insertRow({ ...data, id });
    },

    async remove(id) {
      const where = whereId(id);
      if (!where) return false;
      const existing = await readOne(where);
      if (!existing) return false;
      await spec.beforeRemove?.(ctx, existing);
      const res = await withWrite(() => delegate.deleteMany({ where }));
      if (res.count > 0) await bump(existing);
      return res.count > 0;
    },
  };
};

export { NIL_UUID };

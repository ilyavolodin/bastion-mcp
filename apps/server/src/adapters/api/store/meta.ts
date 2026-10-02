/**
 * Schema metadata for the generic resource store: which Prisma models exist, how their scalar fields are typed and
 * which columns are `uuid`, nullable or arrays. The Prisma runtime data model lists fields and types; the column
 * facts (uuid, nullable, array) come from `information_schema` once per process, so the store never hard-codes a
 * second copy of the schema (16.2).
 */
import type { PrismaClient } from '@bastion-mcp/db';

export type FieldMeta = {
  name: string;
  /** Prisma scalar type: String, Int, Boolean, DateTime, Json, Bytes, BigInt, Float, Decimal. */
  type: string;
  column: string;
  uuid: boolean;
  nullable: boolean;
  array: boolean;
};

export type ModelMeta = {
  model: string;
  /** Property of the Prisma client, for example `teamMembership`. */
  delegate: string;
  table: string;
  fields: Map<string, FieldMeta>;
};

export type StoreMeta = { models: Map<string, ModelMeta> };

type RuntimeField = { name: string; kind: string; type: string; dbName?: string | null };
type RuntimeModel = { fields: RuntimeField[]; dbName?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

let cache: WeakMap<object, Promise<StoreMeta>> | undefined;

/** Loads (and caches per client) the model metadata. */
export const loadStoreMeta = (prisma: PrismaClient): Promise<StoreMeta> => {
  cache ??= new WeakMap();
  const hit = cache.get(prisma);
  if (hit) return hit;
  const promise = build(prisma);
  cache.set(prisma, promise);
  promise.catch(() => cache?.delete(prisma));
  return promise;
};

const build = async (prisma: PrismaClient): Promise<StoreMeta> => {
  const runtime = (
    prisma as unknown as { _runtimeDataModel?: { models: Record<string, RuntimeModel> } }
  )._runtimeDataModel;
  if (!runtime) throw new Error('the Prisma client does not expose its runtime data model');
  const columns = await prisma.$queryRaw<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }[]
  >`SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'`;
  const byColumn = new Map(columns.map((c) => [`${c.table_name}.${c.column_name}`, c]));
  const models = new Map<string, ModelMeta>();
  for (const [name, model] of Object.entries(runtime.models)) {
    const table = model.dbName ?? name;
    const fields = new Map<string, FieldMeta>();
    for (const f of model.fields) {
      if (f.kind !== 'scalar') continue;
      const column = f.dbName ?? f.name;
      const info = byColumn.get(`${table}.${column}`);
      fields.set(f.name, {
        name: f.name,
        type: f.type,
        column,
        uuid: info?.udt_name === 'uuid' || info?.udt_name === '_uuid',
        nullable: info?.is_nullable === 'YES',
        array: info?.data_type === 'ARRAY',
      });
    }
    models.set(name, { model: name, delegate: lowerFirst(name), table, fields });
  }
  return { models };
};

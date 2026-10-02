/**
 * Collections of the API that are not one table: `settings` (one `org_settings` row per key), `service_account_clients`
 * (the client lives in the account row), `oauth_grants` (oidc-provider `Grant` models), `installation_secrets`
 * (references kept in `installations.secret_refs`) and `overrides` (stored inside versions and installations, so the
 * collection itself is always empty).
 */
import {
  decodeOffset,
  encodeOffset,
  type ListQuery,
  NotFoundApiError,
  type Page,
  type Row,
  UnavailableApiError,
} from '@bastion-mcp/api';
import { NIL_UUID, nextUpdatedAt, Prisma } from '@bastion-mcp/db';
import type { CollectionStore, DbRow, StoreContext } from './collection';
import { isUuid } from './meta';

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const tx = (ctx: StoreContext): Prisma.TransactionClient => ctx.db as Prisma.TransactionClient;

const matches = (row: Row, where: Record<string, unknown> | undefined): boolean =>
  !where || Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);

const paginate = (rows: Row[], query: ListQuery): Page<Row> => {
  const offset = decodeOffset(query.cursor);
  const sorted = query.sort
    ? [...rows].sort((a, b) => {
        const av = String(a[query.sort?.field ?? ''] ?? '');
        const bv = String(b[query.sort?.field ?? ''] ?? '');
        return (av < bv ? -1 : av > bv ? 1 : 0) * (query.sort?.desc ? -1 : 1);
      })
    : rows;
  const items = sorted.slice(offset, offset + query.limit);
  return {
    items,
    nextCursor: offset + query.limit < sorted.length ? encodeOffset(offset + query.limit) : null,
  };
};

/** A collection implemented over a loader of every row: filters, search and paging run in memory. */
const inMemory = (
  load: () => Promise<Row[]>,
  write: {
    upsert?: (id: string, data: Record<string, unknown>) => Promise<Row>;
    remove?: (id: string) => Promise<boolean>;
  } = {},
): CollectionStore => {
  const fail = (what: string) => (): never => {
    throw new UnavailableApiError(`${what} on this collection`);
  };
  return {
    async list(query) {
      let rows = (await load()).filter((r) => matches(r, query.where));
      if (query.q) {
        const needle = query.q.toLowerCase();
        rows = rows.filter((r) =>
          Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)),
        );
      }
      return paginate(rows, query);
    },
    async get(id) {
      return (await load()).find((r) => r.id === id) ?? null;
    },
    async find(where) {
      return (await load()).filter((r) => matches(r, where));
    },
    insert: async (data) => {
      if (!write.upsert) return fail('insert')();
      return write.upsert(String(data.id ?? ''), data);
    },
    update: async (id, patch) => {
      if (!write.upsert) return fail('update')();
      return write.upsert(id, patch);
    },
    upsert: async (id, data) => {
      if (!write.upsert) return fail('upsert')();
      return write.upsert(id, data);
    },
    remove: async (id) => {
      if (!write.remove) return fail('remove')();
      return write.remove(id);
    },
  };
};

// --- settings -----------------------------------------------------------------------------------------------------------

export const createSettingsCollection = (ctx: StoreContext): CollectionStore => {
  const toRow = (r: {
    key: string;
    value: unknown;
    updatedAt: Date;
    updatedBy: string | null;
  }): Row => ({
    id: r.key,
    key: r.key,
    value: r.value,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  });
  const bump = async (): Promise<void> => {
    if (ctx.unit) ctx.unit.bump('org', NIL_UUID);
  };
  const put = async (id: string, data: Record<string, unknown>): Promise<Row> => {
    const db = tx(ctx);
    const existing = await db.orgSetting.findUnique({ where: { key: id } });
    const updatedAt = nextUpdatedAt({
      createdAt: existing?.updatedAt ?? new Date(0),
      updatedAt: existing?.updatedAt ?? null,
    });
    const value = data.value === undefined ? (existing?.value ?? null) : data.value;
    const updatedBy =
      typeof data.updatedBy === 'string' && isUuid(data.updatedBy)
        ? data.updatedBy
        : (existing?.updatedBy ?? null);
    const json = (value === null ? Prisma.JsonNull : value) as Prisma.InputJsonValue;
    const saved = await db.orgSetting.upsert({
      where: { key: id },
      create: { key: id, value: json, updatedAt, updatedBy },
      update: { value: json, updatedAt, updatedBy },
    });
    await bump();
    return toRow(saved);
  };
  return {
    ...inMemory(
      async () => (await tx(ctx).orgSetting.findMany({ orderBy: { key: 'asc' } })).map(toRow),
      {
        upsert: put,
        remove: async (id) => {
          const res = await tx(ctx).orgSetting.deleteMany({ where: { key: id } });
          if (res.count > 0) await bump();
          return res.count > 0;
        },
      },
    ),
    async get(id) {
      const r = await tx(ctx).orgSetting.findUnique({ where: { key: id } });
      return r ? toRow(r) : null;
    },
    async update(id, patch) {
      if (!(await tx(ctx).orgSetting.findUnique({ where: { key: id } }))) {
        throw new NotFoundApiError('setting');
      }
      return put(id, patch);
    },
  };
};

// --- service account clients ----------------------------------------------------------------------------------------

/** The OAuth client of a service account lives in the account row (port-matrix 2); its id is the client id. */
export const createServiceAccountClients = (ctx: StoreContext): CollectionStore => {
  const toRow = (a: DbRow): Row => ({
    id: String(a.oauthClientId),
    serviceAccountId: String(a.id),
    authMethod: a.authMethod,
    secretSha256: a.secretSha256 ?? null,
    jwks: a.jwks ?? null,
    updatedAt: ((a.updatedAt ?? a.createdAt) as Date).toISOString(),
  });
  const accounts = () => tx(ctx).serviceAccount;
  const columns = (data: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (data.authMethod !== undefined) out.authMethod = data.authMethod;
    if (data.secretSha256 !== undefined) out.secretSha256 = data.secretSha256;
    if (data.jwks !== undefined) out.jwks = data.jwks === null ? Prisma.DbNull : data.jwks;
    return out;
  };
  const byClient = async (clientId: string) =>
    clientId ? accounts().findFirst({ where: { oauthClientId: clientId } }) : null;
  const touch = async (accountId: string, data: Record<string, unknown>): Promise<Row> => {
    const current = await accounts().findUnique({ where: { id: accountId } });
    if (!current) throw new NotFoundApiError('service account');
    const updated = await accounts().update({
      where: { id: accountId },
      data: {
        ...data,
        updatedAt: nextUpdatedAt({ createdAt: current.createdAt, updatedAt: current.updatedAt }),
      },
    });
    return toRow(updated as unknown as DbRow);
  };
  return {
    async list(query) {
      const rows = (await accounts().findMany({ where: { oauthClientId: { not: null } } })).map(
        (a) => toRow(a as unknown as DbRow),
      );
      return paginate(
        rows.filter((r) => matches(r, query.where)),
        query,
      );
    },
    async get(id) {
      const a = await byClient(id);
      return a ? toRow(a as unknown as DbRow) : null;
    },
    async find(where) {
      const rows = (await accounts().findMany({ where: { oauthClientId: { not: null } } })).map(
        (a) => toRow(a as unknown as DbRow),
      );
      return rows.filter((r) => matches(r, where));
    },
    async insert(data) {
      const accountId = String(data.serviceAccountId ?? '');
      const clientId = String(data.id ?? '');
      if (!isUuid(accountId)) throw new NotFoundApiError('service account');
      return touch(accountId, { ...columns(data), oauthClientId: clientId });
    },
    async update(id, patch) {
      const a = await byClient(id);
      if (!a) throw new NotFoundApiError('service account client');
      return touch(a.id, columns(patch));
    },
    async upsert(id, data) {
      const a = await byClient(id);
      if (a) return touch(a.id, columns(data));
      return this.insert({ ...data, id });
    },
    async remove(id) {
      const a = await byClient(id);
      if (!a) return false;
      await touch(a.id, { oauthClientId: null, secretSha256: null, jwks: Prisma.DbNull });
      return true;
    },
  };
};

// --- OAuth grants -------------------------------------------------------------------------------------------------------

/** `oidc_models` rows of type `Grant`: one per (user, client) consent (9.3, 9.4). */
export const createOAuthGrants = (ctx: StoreContext): CollectionStore => {
  const toRow = (r: { id: string; payload: unknown; expiresAt: Date | null }): Row => {
    const p = obj(r.payload);
    const iat =
      typeof p.iat === 'number' ? new Date(p.iat * 1000).toISOString() : new Date(0).toISOString();
    const scopes = [
      ...String(obj(p.openid).scope ?? '').split(' '),
      ...Object.values(obj(p.resources)).flatMap((s) => String(s).split(' ')),
    ].filter(Boolean);
    return {
      id: r.id,
      userId: String(p.accountId ?? ''),
      clientId: String(p.clientId ?? ''),
      scopes: [...new Set(scopes)],
      resources: Object.keys(obj(p.resources)),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: iat,
      updatedAt: iat,
    };
  };
  const rows = async (where: Record<string, unknown> = {}): Promise<Row[]> => {
    const found = await tx(ctx).oidcModel.findMany({
      where: {
        type: 'Grant',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(typeof where.userId === 'string'
          ? { payload: { path: ['accountId'], equals: where.userId } }
          : {}),
      },
      orderBy: { id: 'asc' },
    });
    return found.map(toRow).filter((r) => matches(r, where));
  };
  return {
    async list(query) {
      return paginate(await rows(query.where), query);
    },
    async get(id) {
      const found = await tx(ctx).oidcModel.findUnique({
        where: { type_id: { type: 'Grant', id } },
      });
      return found ? toRow(found) : null;
    },
    find: (where) => rows(where),
    insert: () => {
      throw new UnavailableApiError('creating grants through the API');
    },
    update: () => {
      throw new UnavailableApiError('updating grants through the API');
    },
    upsert: () => {
      throw new UnavailableApiError('creating grants through the API');
    },
    /** Revoking a grant also drops the tokens issued under it (9.4). */
    async remove(id) {
      const db = tx(ctx);
      await db.oidcModel.deleteMany({ where: { grantId: id } });
      const res = await db.oidcModel.deleteMany({ where: { type: 'Grant', id } });
      return res.count > 0;
    },
  };
};

// --- installation secrets -------------------------------------------------------------------------------------------------

export const createInstallationSecrets = (ctx: StoreContext): CollectionStore => {
  const load = async (): Promise<Row[]> => {
    const rows = await tx(ctx).installation.findMany({
      select: { id: true, secretRefs: true, updatedAt: true, createdAt: true },
    });
    return rows.flatMap((i) =>
      Object.entries(obj(i.secretRefs)).map(([name, ref]) => ({
        ...obj(ref),
        secretName: obj(ref).name ?? name,
        id: `${i.id}:${name}`,
        installationId: i.id,
        name,
        updatedAt: (i.updatedAt ?? i.createdAt).toISOString(),
      })),
    );
  };
  const split = (id: string): [string, string] | null => {
    const at = id.indexOf(':');
    return at < 0 || !isUuid(id.slice(0, at)) ? null : [id.slice(0, at), id.slice(at + 1)];
  };
  const set = async (id: string, data: Record<string, unknown> | null): Promise<boolean> => {
    const parts = split(id);
    if (!parts) return false;
    const db = tx(ctx);
    const inst = await db.installation.findUnique({ where: { id: parts[0] } });
    if (!inst) return false;
    const refs = { ...obj(inst.secretRefs) };
    if (data === null) {
      if (!(parts[1] in refs)) return false;
      delete refs[parts[1]];
    } else {
      const { id: _id, installationId: _i, name: _n, updatedAt: _u, ...ref } = data;
      refs[parts[1]] = ref;
    }
    await db.installation.update({
      where: { id: parts[0] },
      data: {
        secretRefs: refs as Prisma.InputJsonValue,
        updatedAt: nextUpdatedAt({ createdAt: inst.createdAt, updatedAt: inst.updatedAt }),
      },
    });
    ctx.unit?.bump('installation', parts[0]);
    return true;
  };
  return inMemory(load, {
    upsert: async (id, data) => {
      await set(id, data);
      return (
        (await load()).find((r) => r.id === id) ??
        ({ id, updatedAt: new Date().toISOString() } as Row)
      );
    },
    remove: (id) => set(id, null),
  });
};

// --- overrides ------------------------------------------------------------------------------------------------------------

export const createOverridesCollection = (): CollectionStore => inMemory(async () => []);

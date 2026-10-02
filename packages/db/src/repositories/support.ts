import { BastionError, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import { type AuditInput, appendAuditEvent } from '../audit';
import { bumpConfigVersion, NIL_UUID } from '../config-version';
import { Prisma, type PrismaClient } from '../generated/client';

/** A client or an interactive-transaction client: what every repository factory accepts. */
export type PrismaLike = PrismaClient | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;

// --- errors (5.4: BastionError subclasses with stable codes) ------------------------------------------

/** 412: the `If-Match` ETag no longer matches the row (17.1). */
export class PreconditionFailedError extends BastionError {
  constructor(message = 'the resource was modified; reload and retry', data = {}) {
    super('PRECONDITION_FAILED', message, { httpStatus: 412, data });
  }
}

/** 428: a mutating request arrived without `If-Match` (17.1). */
export class PreconditionRequiredError extends BastionError {
  constructor() {
    super('PRECONDITION_REQUIRED', 'If-Match header is required', { httpStatus: 428 });
  }
}

export class NotFoundError extends BastionError {
  constructor(what: string, id?: string) {
    super('NOT_FOUND', `${what} not found`, { httpStatus: 404, data: id ? { id } : {} });
  }
}

export class ConflictError extends BastionError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super('CONFLICT', message, { httpStatus: 409, data });
  }
}

export class InvalidCursorError extends BastionError {
  constructor() {
    super('INVALID_CURSOR', 'the pagination cursor is invalid', { httpStatus: 400 });
  }
}

/** Postgres unique violation as raised through Prisma (`P2002`). */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Runs `fn`, converting a unique violation into a `ConflictError`. */
export const orConflict = async <T>(
  what: string,
  fn: () => Promise<T>,
  data: Record<string, unknown> = {},
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`${what} already exists`, data);
    throw error;
  }
};

// --- ETag / If-Match (17.1) ------------------------------------------------------------------------

export type Versioned = { createdAt: Date; updatedAt: Date | null };

/** The ETag of a row: its `updated_at` (or `created_at` before the first update) in epoch ms. */
export const etagOf = (row: Versioned): string =>
  `"${(row.updatedAt ?? row.createdAt).getTime().toString(36)}"`;

const stripEtag = (value: string): string => value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/** Throws 428 without `If-Match` and 412 when it does not match the row (`*` always matches). */
export const assertIfMatch = (row: Versioned, ifMatch: string | undefined): void => {
  if (ifMatch === undefined || ifMatch.trim() === '') throw new PreconditionRequiredError();
  const wanted = ifMatch
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (wanted.includes('*')) return;
  const current = stripEtag(etagOf(row));
  if (!wanted.some((v) => stripEtag(v) === current)) throw new PreconditionFailedError();
};

/** The `where` fragment that makes an `updateMany` a compare-and-swap on the row version. */
export const versionGuard = (row: Versioned): { updatedAt: Date | null } => ({
  updatedAt: row.updatedAt,
});

/** The next `updated_at`: now, but always strictly after the current version so ETags never repeat. */
export const nextUpdatedAt = (row: Versioned, now: Date = new Date()): Date => {
  const current = (row.updatedAt ?? row.createdAt).getTime();
  return new Date(Math.max(now.getTime(), current + 1));
};

/** Asserts the compare-and-swap affected one row: a concurrent writer won otherwise (412). */
export const assertSwapped = (result: { count: number }): void => {
  if (result.count !== 1) throw new PreconditionFailedError();
};

// --- pagination (17.1) --------------------------------------------------------------------------------

export type Paged<T> = { items: T[]; nextCursor: string | null };

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export const clampLimit = (limit: number | undefined): number =>
  Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit ?? DEFAULT_PAGE_SIZE)));

const cursorSchema = z
  .array(z.union([z.string(), z.number()]))
  .min(1)
  .max(4);

/** Opaque cursor: base64url of a JSON array of the sort-key values of the last row. */
export const encodeCursor = (values: readonly (string | number)[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

export const decodeCursor = (cursor: string | undefined): (string | number)[] | undefined => {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
};

/** Cuts a `limit + 1` fetch into a page; the extra row only signals that more exist. */
export const toPage = <T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => (string | number)[],
): Paged<T> => {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1] as T;
  return { items, nextCursor: encodeCursor(cursorOf(last)) };
};

/**
 * Keyset condition for rows ordered by `id desc`. Ids are UUIDv7, so this is "newest first" and, unlike
 * a timestamp (stored with microseconds, read with milliseconds), an exact total order.
 */
export const afterIdDesc = (cursor: string | undefined): Record<string, unknown> => {
  const c = decodeCursor(cursor);
  if (!c) return {};
  const [id] = c;
  if (typeof id !== 'string') throw new InvalidCursorError();
  return { id: { lt: id } };
};

/** Keyset condition for `id asc`. */
export const afterIdAsc = (cursor: string | undefined): Record<string, unknown> => {
  const c = decodeCursor(cursor);
  if (!c) return {};
  const [id] = c;
  if (typeof id !== 'string') throw new InvalidCursorError();
  return { id: { gt: id } };
};

export const idCursorOf = (row: { id: string }): (string | number)[] => [row.id];

/** Keyset condition for rows ordered by one unique string column ascending (slug, email, name). */
export const afterStringAsc = (
  field: string,
  cursor: string | undefined,
): Record<string, unknown> => {
  const c = decodeCursor(cursor);
  if (!c) return {};
  const [value] = c;
  if (typeof value !== 'string') throw new InvalidCursorError();
  return { [field]: { gt: value } };
};

// --- JSON and bytes -----------------------------------------------------------------------------------

/** Value for a non-null `Json` column. */
export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** Value for a nullable `Json` column: SQL NULL for null/undefined. */
export const toJsonOrNull = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);

/**
 * Drops `undefined` values so a zod-parsed object (`x?: T | undefined`) satisfies a port type declared with
 * `exactOptionalPropertyTypes` (`x?: T`), which `apps/server` enables.
 */
export const compact = <T extends object>(value: object): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

/** Copies into a fresh `Uint8Array<ArrayBuffer>`, the type Prisma accepts for `Bytes` columns. */
export const toBytes = (data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(data.length));
  out.set(data);
  return out;
};

export const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  toBytes(Buffer.from(hex, 'hex'));

export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// --- unit of work: audit and config bumps in the mutation's transaction (17.1, 4.3) ----------------------

/** Who performed a mutation; repositories add the action, target and diff. */
export type AuditContext = {
  actorType: string;
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export type AuditEventSpec = {
  action: string;
  targetType: string;
  targetId?: string | null;
  diff?: unknown;
};

export const CONFIG_SCOPES = [
  'org',
  'user',
  'team',
  'installation',
  'catalog',
  'endpoint',
] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/** `{scope, id, version}` as published on `bastion:config` after the commit (4.3). */
export type ConfigEvent = { scope: ConfigScope; id: string; version: bigint };
export type ConfigPublisher = (event: ConfigEvent) => void | Promise<void>;

/** Work recorded while repository methods run inside one transaction. */
export class UnitState {
  readonly bumps = new Map<string, { scope: ConfigScope; id: string }>();
  readonly audits: AuditInput[] = [];
  readonly afterCommit: (() => void | Promise<void>)[] = [];

  bump(scope: ConfigScope, id: string = NIL_UUID): void {
    this.bumps.set(`${scope}:${id}`, { scope, id });
  }

  audit(ctx: AuditContext | undefined, spec: AuditEventSpec): void {
    if (!ctx) return;
    this.audits.push({ ...ctx, ...spec });
  }
}

export type RepoOptions = {
  /** Called after commit with each bumped `(scope, id, version)`; failures never fail the mutation. */
  publishConfig?: ConfigPublisher;
  onPublishError?: (error: unknown, event: ConfigEvent | undefined) => void;
};

/** What a repository factory receives: the database handle plus the unit it participates in. */
export type RepoContext = RepoOptions & { db: PrismaLike; unit?: UnitState | undefined };

const isRepoContext = (value: PrismaLike | RepoContext): value is RepoContext =>
  !('$queryRaw' in value);

export const toContext = (arg: PrismaLike | RepoContext, options: RepoOptions = {}): RepoContext =>
  isRepoContext(arg) ? { ...options, ...arg } : { ...options, db: arg };

/** Interactive-transaction clients still expose `$transaction` at runtime; only the root client has `$connect`. */
const isClient = (db: PrismaLike): db is PrismaClient => '$connect' in db;

/** Applies bumps in a fixed order (no deadlocks between units) and appends audit events. */
export const flushUnit = async (tx: Tx, unit: UnitState): Promise<ConfigEvent[]> => {
  const events: ConfigEvent[] = [];
  const ordered = [...unit.bumps.values()].sort((a, b) =>
    `${a.scope}:${a.id}` < `${b.scope}:${b.id}` ? -1 : 1,
  );
  for (const { scope, id } of ordered) {
    events.push({ scope, id, version: await bumpConfigVersion(tx, scope, id) });
  }
  for (const audit of unit.audits) await appendAuditEvent(tx, audit);
  return events;
};

export const publishAfterCommit = async (
  options: RepoOptions,
  events: readonly ConfigEvent[],
  unit: UnitState,
): Promise<void> => {
  const { publishConfig } = options;
  if (publishConfig) {
    for (const event of events) {
      try {
        await publishConfig(event);
      } catch (error) {
        options.onPublishError?.(error, event);
      }
    }
  }
  for (const hook of unit.afterCommit) {
    try {
      await hook();
    } catch (error) {
      options.onPublishError?.(error, undefined);
    }
  }
};

export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Runs a mutation. Inside `withTransaction` the work joins that unit; otherwise it gets its own
 * transaction that also bumps config versions and appends the audit events, then publishes.
 */
export const mutate = async <T>(
  ctx: RepoContext,
  fn: (tx: Tx, unit: UnitState) => Promise<T>,
): Promise<T> => {
  if (ctx.unit) return fn(ctx.db as Tx, ctx.unit);
  const run = async (tx: Tx): Promise<{ out: T; unit: UnitState; events: ConfigEvent[] }> => {
    const unit = new UnitState();
    const out = await fn(tx, unit);
    return { out, unit, events: await flushUnit(tx, unit) };
  };
  const done = isClient(ctx.db) ? await ctx.db.$transaction(run, TX_OPTIONS) : await run(ctx.db);
  await publishAfterCommit(ctx, done.events, done.unit);
  return done.out;
};

export { newId };

/** 422: the input is well formed but not acceptable (a bad slug, an unknown reference). */
export class ValidationError extends BastionError {
  constructor(message: string, data: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, { httpStatus: 422, data });
  }
}

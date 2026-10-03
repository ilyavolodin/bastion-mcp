import { randomBytes } from 'node:crypto';
import { ConflictApiError, NotFoundApiError } from '../errors';
import { type ListQueryInput, toListQuery } from '../framework/conventions';
import type { BaseContext, MutationTx, RouteSchema } from '../framework/route';
import type { ApiDeps } from '../ports';
import type { Collection, Page, Row } from '../ports/store';

/** What a service needs from a route context. */
export type ReadCtx = Pick<
  BaseContext<RouteSchema>,
  'deps' | 'principal' | 'subject' | 'can' | 'authorize'
>;
export type WriteCtx = ReadCtx & { tx: MutationTx };

export type CrudConfig = {
  collection: Collection;
  /** Audit target type, for example `team`. */
  targetType: string;
  /** Audit action prefix, for example `team` -> `team.create`. */
  action: string;
  /** Topic published on `bastion:config` after commit, when the resource affects workers (4.3). */
  configTopic?: string;
  /** Removes fields that must never leave the API (hashes, secrets). */
  view?: (row: Row) => Row;
  /** Field that must be unique across the collection (409 on a duplicate). */
  unique?: string;
};

const SENSITIVE = /secret|token|password|hash|private|credential/i;

/** Audit diffs never carry secret-looking values (22.3). */
export const redact = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : v]),
  );

/** A random base64url token of `bytes` bytes from the injected source (default `crypto.randomBytes`). */
export const randomToken = (deps: ApiDeps, bytes: number): string =>
  deps.randomToken ? deps.randomToken(bytes) : randomBytes(bytes).toString('base64url');

export const nowIso = (deps: ApiDeps): string => deps.clock.now().toISOString();

/** Generic list/get/create/update/delete with the 17.1 conventions and an audit event per write. */
export class CrudService {
  constructor(private readonly cfg: CrudConfig) {}

  private view(row: Row): Row {
    return this.cfg.view ? this.cfg.view(row) : row;
  }

  async list(
    ctx: Pick<ReadCtx, 'deps'>,
    query: ListQueryInput,
    where?: Record<string, unknown>,
    keep?: (row: Row) => boolean,
  ): Promise<Page<Row>> {
    const page = await ctx.deps.store.list(this.cfg.collection, toListQuery(query, where));
    const items = keep ? page.items.filter(keep) : page.items;
    return { items: items.map((r) => this.view(r)), nextCursor: page.nextCursor };
  }

  async require(ctx: Pick<ReadCtx, 'deps'>, id: string): Promise<Row> {
    const row = await ctx.deps.store.get(this.cfg.collection, id);
    if (!row) throw new NotFoundApiError(this.cfg.targetType);
    return row;
  }

  async get(ctx: Pick<ReadCtx, 'deps'>, id: string): Promise<Row> {
    return this.view(await this.require(ctx, id));
  }

  async create(ctx: WriteCtx, data: Record<string, unknown>, id?: string): Promise<Row> {
    const { unique } = this.cfg;
    if (unique && data[unique] !== undefined) {
      const clash = await ctx.tx.store.find(this.cfg.collection, { [unique]: data[unique] });
      if (clash.length > 0) {
        throw new ConflictApiError(`a ${this.cfg.targetType} with this ${unique} already exists`);
      }
    }
    const row = await ctx.tx.store.insert(this.cfg.collection, {
      ...data,
      id: id ?? ctx.deps.newId(),
      createdAt: nowIso(ctx.deps),
    });
    await ctx.tx.audit({
      action: `${this.cfg.action}.create`,
      targetType: this.cfg.targetType,
      targetId: row.id,
      diff: { after: redact(data) },
    });
    this.touched(ctx);
    return this.view(row);
  }

  async update(ctx: WriteCtx, id: string, patch: Record<string, unknown>): Promise<Row> {
    const before = await ctx.tx.store.get(this.cfg.collection, id);
    if (!before) throw new NotFoundApiError(this.cfg.targetType);
    const row = await ctx.tx.store.update(this.cfg.collection, id, patch);
    await ctx.tx.audit({
      action: `${this.cfg.action}.update`,
      targetType: this.cfg.targetType,
      targetId: id,
      diff: { changed: Object.keys(patch), patch: redact(patch) },
    });
    this.touched(ctx);
    return this.view(row);
  }

  async remove(ctx: WriteCtx, id: string): Promise<void> {
    const removed = await ctx.tx.store.remove(this.cfg.collection, id);
    if (!removed) throw new NotFoundApiError(this.cfg.targetType);
    await ctx.tx.audit({
      action: `${this.cfg.action}.delete`,
      targetType: this.cfg.targetType,
      targetId: id,
    });
    this.touched(ctx);
  }

  /** Marks the configuration changed so workers refresh their caches (4.3). */
  touched(ctx: WriteCtx): void {
    if (this.cfg.configTopic) ctx.tx.configChanged(this.cfg.configTopic);
  }
}

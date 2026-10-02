import { NotFoundApiError } from '../../src/errors';
import { decodeOffset, encodeOffset } from '../../src/framework/conventions';
import type { Collection, ListQuery, Page, ResourceStore, Row } from '../../src/ports';

type Tables = Map<Collection, Map<string, Row>>;

const matchesWhere = (row: Row, where: Record<string, unknown> | undefined): boolean =>
  !where || Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);

const matchesQuery = (row: Row, q: string | undefined): boolean => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return Object.values(row).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
};

/** In-memory `ResourceStore` with snapshots for transaction rollback. */
export class MemoryStore implements ResourceStore {
  private tables: Tables = new Map();
  private tick = 0;
  private seq = 0;
  constructor(private readonly base = Date.UTC(2026, 0, 1)) {}

  private table(collection: Collection): Map<string, Row> {
    let t = this.tables.get(collection);
    if (!t) {
      t = new Map();
      this.tables.set(collection, t);
    }
    return t;
  }

  private stamp(): string {
    this.tick += 1;
    return new Date(this.base + this.tick).toISOString();
  }

  snapshot(): Tables {
    return new Map([...this.tables].map(([k, v]) => [k, new Map(v)]));
  }

  restore(snapshot: Tables): void {
    this.tables = snapshot;
  }

  async list(collection: Collection, query: ListQuery): Promise<Page<Row>> {
    let rows = [...this.table(collection).values()].filter(
      (r) => matchesWhere(r, query.where) && matchesQuery(r, query.q),
    );
    const sort = query.sort;
    if (sort) {
      rows.sort((a, b) => {
        const av = String(a[sort.field] ?? '');
        const bv = String(b[sort.field] ?? '');
        return (av < bv ? -1 : av > bv ? 1 : 0) * (sort.desc ? -1 : 1);
      });
    } else {
      rows = rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const offset = decodeOffset(query.cursor);
    const items = rows.slice(offset, offset + query.limit);
    const next = offset + query.limit;
    return { items, nextCursor: next < rows.length ? encodeOffset(next) : null };
  }

  async get(collection: Collection, id: string): Promise<Row | null> {
    return this.table(collection).get(id) ?? null;
  }

  async find(collection: Collection, where: Record<string, unknown>): Promise<Row[]> {
    return [...this.table(collection).values()].filter((r) => matchesWhere(r, where));
  }

  async insert(
    collection: Collection,
    data: Record<string, unknown> & { id?: string },
  ): Promise<Row> {
    this.seq += 1;
    const id = data.id ?? `${collection}-${this.seq}`;
    const row: Row = { ...data, id, updatedAt: this.stamp() };
    this.table(collection).set(id, row);
    return row;
  }

  async update(collection: Collection, id: string, patch: Record<string, unknown>): Promise<Row> {
    const current = this.table(collection).get(id);
    if (!current) throw new NotFoundApiError(collection);
    const row: Row = { ...current, ...patch, id, updatedAt: this.stamp() };
    this.table(collection).set(id, row);
    return row;
  }

  async upsert(collection: Collection, id: string, data: Record<string, unknown>): Promise<Row> {
    const row: Row = { ...data, id, updatedAt: this.stamp() };
    this.table(collection).set(id, row);
    return row;
  }

  async remove(collection: Collection, id: string): Promise<boolean> {
    return this.table(collection).delete(id);
  }

  /** Test helper: seeds a row without bumping anything unexpected. */
  async seed(collection: Collection, data: Record<string, unknown> & { id: string }): Promise<Row> {
    return this.insert(collection, data);
  }
}

import type {
  InstallRequestStore,
  RegistryServerRow,
  RegistryServerStore,
  RegistrySourceStore,
  SyncResult,
} from '@bastion-mcp/registry';
import type { ApiDeps } from '../../../src/ports';
import type { FakeCtx } from '../harness';
import { registryServerRows } from '../registry-fixtures';

export class MemoryServerStore implements RegistryServerStore {
  constructor(readonly rows: RegistryServerRow[]) {}
  async upsert(rows: readonly RegistryServerRow[]) {
    this.rows.push(...rows);
  }
  async list(sourceId: string, options?: { name?: string }) {
    return this.rows.filter(
      (r) => r.sourceId === sourceId && (!options?.name || r.name === options.name),
    );
  }
  async search(query: { q?: string; sourceId?: string; includeDeleted?: boolean; limit: number }) {
    const q = query.q?.toLowerCase();
    const items = this.rows.filter(
      (r) =>
        (!query.sourceId || r.sourceId === query.sourceId) &&
        (query.includeDeleted || r.status !== 'deleted') &&
        (!q || r.searchDocument.includes(q)),
    );
    return { items: items.slice(0, query.limit) };
  }
}

/** OSV answering `no advisories` for every queried package. */
export const cleanOsv = async (
  _url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const queries = (JSON.parse(String(init?.body ?? '{}')) as { queries?: unknown[] }).queries ?? [];
  return new Response(JSON.stringify({ results: queries.map(() => ({})) }), { status: 200 });
};

/** OSV flagging every queried package as known-malicious. */
export const maliciousOsv = async (
  _url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const queries = (JSON.parse(String(init?.body ?? '{}')) as { queries?: unknown[] }).queries ?? [];
  return new Response(
    JSON.stringify({ results: queries.map(() => ({ vulns: [{ id: 'MAL-2026-1' }] })) }),
    { status: 200 },
  );
};

export const syncCalls: Array<{ id: string; full: boolean }> = [];

const unusedSources = {} as RegistrySourceStore;
const unusedRequests = {} as InstallRequestStore;

/** In-memory registry mirror plus a sync that reports a clean run; the fake resolver is public. */
export const makeRegistry = (patch: Partial<ApiDeps['registry']> = {}): ApiDeps['registry'] => ({
  ...{
    sources: unusedSources,
    servers: new MemoryServerStore(registryServerRows()),
    requests: unusedRequests,
    resolveHost: async () => ['93.184.216.34'],
    fetch: cleanOsv,
    sync: async (source, options): Promise<SyncResult> => {
      syncCalls.push({ id: source.id, full: options.full === true });
      return {
        ok: true,
        stats: {
          startedAt: '2026-06-01T12:00:00.000Z',
          finishedAt: '2026-06-01T12:00:01.000Z',
          ok: true,
          full: options.full === true,
          pages: 1,
          fetched: 3,
          upserted: 3,
          invalid: 0,
          deleted: 1,
          deprecated: 0,
        },
        deletedNames: ['io.github.acme/gone'],
        deprecatedNames: [],
      };
    },
  },
  ...patch,
});

export const fakeRegistryDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({ registry: makeRegistry() });

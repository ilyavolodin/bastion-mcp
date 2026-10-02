import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSearchDocument,
  FULL_RESYNC_INTERVAL_MS,
  isFullResyncDue,
  isSyncDue,
  type RegistryServerRow,
  type RegistryServerStore,
  type RegistrySource,
  type RegistrySourceStore,
  type SyncStats,
  serverJsonSchema,
  syncSource,
  UPDATED_SINCE_OVERLAP_MS,
} from '../src';
import { type FakeRegistry, startFakeRegistry } from './fake-registry';
import * as fx from './fixtures/server-json';

let fake: FakeRegistry;
beforeAll(async () => {
  fake = await startFakeRegistry();
});
afterAll(async () => {
  await fake.close();
});

const NOW = new Date('2026-03-01T12:00:00Z');

const makeSource = (over: Partial<RegistrySource> = {}): RegistrySource => ({
  id: 'src-1',
  name: 'Test registry',
  baseUrl: fake.baseUrl,
  trust: 'community',
  enabled: true,
  syncIntervalS: 3600,
  lastUpdatedSince: null,
  lastSync: null,
  ...over,
});

const memory = () => {
  const rows = new Map<string, RegistryServerRow>();
  const recorded: { lastSync: SyncStats; lastUpdatedSince?: Date | undefined }[] = [];
  const serverStore: RegistryServerStore = {
    upsert: async (batch) => {
      for (const r of batch) rows.set(`${r.sourceId}|${r.name}|${r.version}`, r);
    },
    list: async () => [...rows.values()],
    search: async () => ({ items: [...rows.values()] }),
  };
  const sourceStore: RegistrySourceStore = {
    get: async () => null,
    list: async () => [],
    save: async () => undefined,
    remove: async () => undefined,
    recordSync: async (_id, result) => {
      recorded.push(result);
    },
  };
  return { rows, recorded, serverStore, sourceStore };
};

const deps = (m: ReturnType<typeof memory>) => ({
  serverStore: m.serverStore,
  sourceStore: m.sourceStore,
  secrets: { resolve: async () => undefined },
  clock: { now: () => NOW },
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.setEntries([]);
});

describe('11.6 syncSource', () => {
  it('11.6 first sync is a full walk that upserts every page and advances updated_since', async () => {
    fake.setEntries(
      Array.from({ length: 150 }, (_, i) =>
        fx.entryOf({ ...fx.npmStdioSecrets, name: `io.github.bulk/s-${i}` }),
      ),
    );
    const m = memory();
    const result = await syncSource(makeSource(), deps(m));
    expect(result.ok).toBe(true);
    expect(m.rows.size).toBe(150);
    expect(result.stats).toMatchObject({ full: true, pages: 2, fetched: 150, upserted: 150 });
    expect(new URL(fake.requests[0]?.url ?? '', 'http://x').searchParams.has('updated_since')).toBe(
      false,
    );
    expect(m.recorded[0]?.lastUpdatedSince?.getTime()).toBe(
      NOW.getTime() - UPDATED_SINCE_OVERLAP_MS,
    );
    expect(m.recorded[0]?.lastSync.lastFullAt).toBe(NOW.toISOString());
  });

  it('11.6 an incremental sync sends updated_since and keeps lastFullAt', async () => {
    const since = new Date('2026-02-28T00:00:00Z');
    const lastSync: SyncStats = {
      startedAt: '2026-02-28T00:00:00Z',
      finishedAt: '2026-02-28T00:00:05Z',
      ok: true,
      full: true,
      pages: 1,
      fetched: 0,
      upserted: 0,
      invalid: 0,
      deleted: 0,
      deprecated: 0,
      lastFullAt: '2026-02-28T00:00:05Z',
    };
    const m = memory();
    const result = await syncSource(makeSource({ lastUpdatedSince: since, lastSync }), deps(m));
    expect(result.stats.full).toBe(false);
    expect(new URL(fake.requests[0]?.url ?? '', 'http://x').searchParams.get('updated_since')).toBe(
      since.toISOString(),
    );
    expect(m.recorded[0]?.lastSync.lastFullAt).toBe('2026-02-28T00:00:05Z');
  });

  it('11.6 a full re-sync runs weekly and can be forced', async () => {
    const old = new Date(NOW.getTime() - FULL_RESYNC_INTERVAL_MS - 1000).toISOString();
    const lastSync: SyncStats = {
      startedAt: old,
      finishedAt: old,
      ok: true,
      full: true,
      pages: 1,
      fetched: 0,
      upserted: 0,
      invalid: 0,
      deleted: 0,
      deprecated: 0,
      lastFullAt: old,
    };
    expect(isFullResyncDue({ lastSync }, NOW)).toBe(true);
    expect(isFullResyncDue({ lastSync: { ...lastSync, lastFullAt: NOW.toISOString() } }, NOW)).toBe(
      false,
    );
    expect(isFullResyncDue({ lastSync: null }, NOW)).toBe(true);

    const m = memory();
    const recent = { ...lastSync, lastFullAt: NOW.toISOString() };
    const forced = await syncSource(
      makeSource({ lastUpdatedSince: new Date(), lastSync: recent }),
      deps(m),
      { full: true },
    );
    expect(forced.stats.full).toBe(true);
    const weekly = await syncSource(
      makeSource({ lastUpdatedSince: new Date(), lastSync }),
      deps(m),
    );
    expect(weekly.stats.full).toBe(true);
  });

  it('11.6 deleted servers are returned for hiding and deprecated ones for the badge', async () => {
    fake.setEntries([
      fx.entryOf(fx.npmStdioSecrets),
      fx.entryOf(fx.deprecatedServer, 'deprecated'),
      fx.entryOf(fx.deletedServer, 'deleted'),
    ]);
    const m = memory();
    const result = await syncSource(makeSource(), deps(m));
    expect(result.deletedNames).toEqual(['io.github.shady/typosquat']);
    expect(result.deprecatedNames).toEqual(['io.github.legacy/old-notes']);
    expect(result.stats).toMatchObject({ deleted: 1, deprecated: 1 });
    const row = m.rows.get('src-1|io.github.shady/typosquat|1.0.0');
    expect(row?.status).toBe('deleted');
    expect(row?.isLatest).toBe(true);
    expect(row?.publishedAt?.toISOString()).toBe('2025-12-20T10:00:00.000Z');
  });

  it('11.6 rows carry the server json, source _meta and a search document', async () => {
    fake.setEntries([fx.entryOf(fx.npmStdioSecrets)]);
    const m = memory();
    await syncSource(makeSource(), deps(m));
    const row = [...m.rows.values()][0];
    expect(row?.serverJson.name).toBe('io.github.acme/github-tools');
    expect(row?.meta).toHaveProperty(['io.modelcontextprotocol.registry/official']);
    expect(row?.searchDocument).toContain('@acme/github-tools-mcp');
  });

  it('21.3 a registry outage leaves mirrored data intact, records the failure and keeps updated_since', async () => {
    fake.setEntries([fx.entryOf(fx.npmStdioSecrets)]);
    const m = memory();
    await syncSource(makeSource(), deps(m));
    expect(m.rows.size).toBe(1);

    fake.failNext(503);
    const since = new Date('2026-02-01T00:00:00Z');
    const result = await syncSource(makeSource({ lastUpdatedSince: since }), deps(m));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/503/);
    expect(m.rows.size).toBe(1);
    const failed = m.recorded[1];
    expect(failed?.lastSync).toMatchObject({ ok: false });
    expect(failed?.lastUpdatedSince).toBeUndefined();
  });

  it('21.3 a failure mid-walk does not advance updated_since', async () => {
    fake.setEntries(
      Array.from({ length: 120 }, (_, i) =>
        fx.entryOf({ ...fx.npmStdioSecrets, name: `io.github.bulk/m-${i}` }),
      ),
    );
    const m = memory();
    // First page succeeds, the second page fails.
    const original = fetch;
    let calls = 0;
    const result = await syncSource(makeSource(), {
      ...deps(m),
      fetch: async (input, init) => {
        calls += 1;
        if (calls === 2) return new Response('down', { status: 500 });
        return original(input, init);
      },
    });
    expect(result.ok).toBe(false);
    expect(m.rows.size).toBe(100);
    expect(m.recorded[0]?.lastUpdatedSince).toBeUndefined();
    expect(result.stats.pages).toBe(1);
  });

  it('21.3 a storage failure is reported, not thrown', async () => {
    fake.setEntries([fx.entryOf(fx.npmStdioSecrets)]);
    const m = memory();
    const result = await syncSource(makeSource(), {
      ...deps(m),
      serverStore: { ...m.serverStore, upsert: async () => Promise.reject(new Error('db down')) },
    });
    expect(result).toMatchObject({ ok: false, error: 'db down' });
  });

  it('11.6 resolves the source auth secret for the registry call', async () => {
    const m = memory();
    await syncSource(makeSource({ authSecretId: 'sec-1' }), {
      ...deps(m),
      secrets: { resolve: async () => 'abc' },
    });
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer abc');
  });

  it('21.3 a missing auth secret fails the sync without throwing', async () => {
    const m = memory();
    const result = await syncSource(makeSource({ authSecretId: 'sec-1' }), deps(m));
    expect(result.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('11.6 scheduling', () => {
  const base = { enabled: true, syncIntervalS: 3600, lastSync: null } as const;

  it('11.6 a disabled source is never due', () => {
    expect(isSyncDue({ ...base, enabled: false }, NOW)).toBe(false);
  });

  it('11.6 a source that never synced is due', () => {
    expect(isSyncDue(base, NOW)).toBe(true);
  });

  it('11.6 is due after the interval (default 1 hour) and not before', () => {
    const finishedAt = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const stats = (ms: number): SyncStats => ({
      startedAt: finishedAt(ms),
      finishedAt: finishedAt(ms),
      ok: true,
      full: false,
      pages: 0,
      fetched: 0,
      upserted: 0,
      invalid: 0,
      deleted: 0,
      deprecated: 0,
    });
    expect(isSyncDue({ ...base, lastSync: stats(3599_000) }, NOW)).toBe(false);
    expect(isSyncDue({ ...base, lastSync: stats(3600_000) }, NOW)).toBe(true);
    expect(isSyncDue({ ...base, lastSync: { ...stats(0), finishedAt: 'garbage' } }, NOW)).toBe(
      true,
    );
  });
});

describe('11.6 buildSearchDocument', () => {
  it('11.6 includes name, split name words, title, description, tags and package identifiers', () => {
    const doc = buildSearchDocument(
      serverJsonSchema.parse({
        ...fx.npmStdioSecrets,
        tags: ['github', 7],
        _meta: { 'io.modelcontextprotocol.registry/publisher-provided': { tags: ['vcs'] } },
      }),
    );
    for (const word of [
      'io.github.acme/github-tools',
      'acme',
      'Acme GitHub Tools',
      'pull requests',
      'github',
      'vcs',
      '@acme/github-tools-mcp',
    ]) {
      expect(doc).toContain(word);
    }
    expect(doc).not.toContain('7');
  });

  it('11.6 omits missing fields without stray separators', () => {
    const doc = buildSearchDocument(
      serverJsonSchema.parse({ name: 'com.x/y', version: '1.0.0', description: '' }),
    );
    expect(doc).toBe('com.x/y com x y');
  });
});

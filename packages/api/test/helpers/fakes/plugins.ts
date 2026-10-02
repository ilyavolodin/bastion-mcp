import {
  type MarketplaceRow,
  type MirrorState,
  PluginStateError,
  type ReleaseRecord,
} from '@bastion-mcp/plugins';
import type { ApiDeps, Row } from '../../../src/ports';
import type { FakeCtx } from '../harness';

export const releaseRecord = (seq: number): ReleaseRecord => ({
  seq,
  items: [{ name: 'plug', version: '1.0.0', policy: 'required' }],
  gitCommit: `commit-${seq}`,
  claudeManifestSha256: 'a'.repeat(64),
  agentsManifestSha256: 'b'.repeat(64),
  archives: {},
  releaseTime: '2026-05-01T00:00:00.000Z',
});

const toRow = (row: Row): MarketplaceRow => ({
  id: row.id,
  slug: String(row.slug),
  displayName: String(row.displayName),
  ownerName: 'Bastion',
  desktopInstallation: 'available',
  promotedRelease: typeof row.promotedRelease === 'number' ? row.promotedRelease : null,
  mirror: (row.mirror as MarketplaceRow['mirror']) ?? null,
  mirrorStatus: (row.mirrorStatus as MarketplaceRow['mirrorStatus']) ?? null,
});

/** `MarketplaceStore`, `ReleaseStore`, `ReleaseService` and `MirrorPusher` over the shared in-memory store. */
export const fakePluginsDeps = (ctx: FakeCtx): Partial<ApiDeps> => {
  const releases = new Map<string, ReleaseRecord[]>([
    ['mkt-team-a', [releaseRecord(1), releaseRecord(2)]],
    ['mkt-org', [releaseRecord(1)]],
  ]);
  const list = (id: string): ReleaseRecord[] => releases.get(id) ?? [];
  const marketplaces = {
    getBySlug: async () => undefined,
    getById: async (id: string) => {
      const row = await ctx.store.get('marketplaces', id);
      return row ? toRow(row) : undefined;
    },
    resolveItems: async () => [],
    loadReleaseItems: async () => [],
    setPromotedRelease: async (id: string, seq: number) => {
      await ctx.store.update('marketplaces', id, { promotedRelease: seq });
    },
    setMirrorStatus: async () => {},
  };
  return {
    plugins: {
      marketplaces,
      releases: {
        get: async (id, seq) => list(id).find((r) => r.seq === seq),
        latest: async (id) => list(id).at(-1),
        list: async (id) => list(id),
        insert: async (id, record) => {
          releases.set(id, [...list(id), record]);
        },
      },
      releaseService: {
        publish: async (id) => {
          const record = releaseRecord(list(id).length + 1);
          releases.set(id, [...list(id), record]);
          return { created: true, record };
        },
        promote: async (id, seq) => {
          const record = list(id).find((r) => r.seq === seq);
          if (!record) throw new PluginStateError('RELEASE_NOT_FOUND', 'release not found', 404);
          await marketplaces.setPromotedRelease(id, seq);
          return record;
        },
      },
      mirror: {
        push: async (): Promise<MirrorState> => ({
          status: 'ok',
          lastPushedSeq: 1,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: '2026-05-01T00:00:00.000Z',
        }),
      },
      usage: async () => ({
        buckets: [
          { ts: '2026-05-01T00:00:00.000Z', channel: 'git', action: 'git_fetch', count: 4 },
        ],
      }),
      syncSource: async () => ({ imported: 0, updated: 0, errors: [] }),
      host: 'bastion.test',
      credentialHelperPath: '/usr/local/bin',
    },
  };
};

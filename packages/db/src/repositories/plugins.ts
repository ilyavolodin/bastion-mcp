import {
  DESKTOP_INSTALLATION_MODES,
  DISTRIBUTION_CHANNELS,
  FILE_MODES,
  isValidMarketplaceSlug,
  MARKETPLACE_ITEM_POLICIES,
  newId,
  PARTITION_DAYS_AHEAD,
} from '@bastion-mcp/core';
import { z } from 'zod';
import { ensurePartitions } from '../partitions';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  bytesToHex,
  ConflictError,
  etagOf,
  hexToBytes,
  isUniqueViolation,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  orConflict,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  toJsonOrNull,
  ValidationError,
  versionedUpdate,
  versionGuard,
} from './support';

// --- shapes (copied from @bastion-mcp/plugins ports) ------------------------------------------------------------------

export type ItemPolicy = (typeof MARKETPLACE_ITEM_POLICIES)[number];

export type MirrorTarget = {
  provider: 'github' | 'gitlab';
  repo: string;
  branch: string;
  credentialSecretId: string;
};

export type MirrorState = {
  status: 'idle' | 'ok' | 'retrying' | 'diverged';
  lastPushedSeq: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type MarketplaceRow = {
  id: string;
  slug: string;
  displayName: string;
  description?: string | undefined;
  ownerName: string;
  desktopInstallation: (typeof DESKTOP_INSTALLATION_MODES)[number];
  promotedRelease: number | null;
  mirror: MirrorTarget | null;
  mirrorStatus: MirrorState | null;
};

export type ReleaseItemRef = { entryId: string; versionId: string; policy: ItemPolicy };

export type ReleaseRecord = {
  seq: number;
  items: { name: string; version: string; policy: ItemPolicy }[];
  gitCommit: string;
  claudeManifestSha256: string;
  agentsManifestSha256: string;
  archives: Record<string, { version: string; sha256: string }>;
  releaseTime: string;
};

export type DistributionEventRecord = {
  ts: Date;
  principalId: string;
  marketplaceId: string;
  releaseSeq: number | null;
  channel: (typeof DISTRIBUTION_CHANNELS)[number];
  action: 'git_fetch' | 'manifest_fetch' | 'archive_download' | 'mirror_push';
  userAgent: string | null;
};

const policySchema = z.enum(MARKETPLACE_ITEM_POLICIES);
const mirrorTargetSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  repo: z.string().min(1),
  branch: z.string().min(1),
  credentialSecretId: z.string().min(1),
});
const mirrorStateSchema = z.object({
  status: z.enum(['idle', 'ok', 'retrying', 'diverged']),
  lastPushedSeq: z.number().int().nullable(),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});
const desktopSchema = z.enum(DESKTOP_INSTALLATION_MODES);
const fileModeSchema = z.enum(FILE_MODES);

const releaseItemsSchema = z.array(
  z.object({
    entryId: z.string(),
    versionId: z.string(),
    policy: policySchema,
    name: z.string(),
    version: z.string(),
  }),
);
const archivesSchema = z.record(z.string(), z.object({ version: z.string(), sha256: z.string() }));

// --- marketplaces CRUD ---------------------------------------------------------------------------------------------------

export type MarketplaceView = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  ownerTeamId: string | null;
  audience: Record<string, unknown>;
  desktopInstallation: (typeof DESKTOP_INSTALLATION_MODES)[number];
  mirror: MirrorTarget | null;
  mirrorStatus: MirrorState | null;
  promotedRelease: number | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

type MarketplaceDbRow = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  ownerTeamId: string | null;
  audience: unknown;
  desktopInstallation: string;
  mirror: unknown;
  mirrorStatus: unknown;
  promotedRelease: number | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const toMarketplaceView = (row: MarketplaceDbRow): MarketplaceView => ({
  id: row.id,
  slug: row.slug,
  displayName: row.displayName,
  description: row.description,
  ownerTeamId: row.ownerTeamId,
  audience: jsonObjectSchema.parse(row.audience),
  desktopInstallation: desktopSchema.parse(row.desktopInstallation),
  mirror: row.mirror === null ? null : mirrorTargetSchema.parse(row.mirror),
  mirrorStatus: row.mirrorStatus === null ? null : mirrorStateSchema.parse(row.mirrorStatus),
  promotedRelease: row.promotedRelease,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type MarketplaceItemInput = {
  catalogEntryId: string;
  policy: ItemPolicy;
  pinnedVersionId?: string | null;
};

export type CreateMarketplaceInput = {
  id?: string;
  slug: string;
  displayName: string;
  description?: string | null;
  ownerTeamId?: string | null;
  audience: Record<string, unknown>;
  desktopInstallation?: (typeof DESKTOP_INSTALLATION_MODES)[number];
  mirror?: MirrorTarget | null;
  createdBy: string;
};

/** Administration of `marketplaces` and `marketplace_items` (25.4). */
export const createMarketplaceRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<MarketplaceView | null> {
      const row = await db.marketplace.findUnique({ where: { id } });
      return row ? toMarketplaceView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ marketplace: MarketplaceView; etag: string } | null> {
      const row = await db.marketplace.findUnique({ where: { id } });
      return row ? { marketplace: toMarketplaceView(row), etag: etagOf(row) } : null;
    },
    async getBySlug(slug: string): Promise<MarketplaceView | null> {
      const row = await db.marketplace.findUnique({ where: { slug } });
      return row ? toMarketplaceView(row) : null;
    },
    async list(): Promise<MarketplaceView[]> {
      const rows = await db.marketplace.findMany({ orderBy: { slug: 'asc' } });
      return rows.map(toMarketplaceView);
    },

    async create(input: CreateMarketplaceInput, audit?: AuditContext): Promise<MarketplaceView> {
      if (!isValidMarketplaceSlug(input.slug))
        throw new ValidationError('invalid marketplace slug');
      const mirror = input.mirror ? mirrorTargetSchema.parse(input.mirror) : null;
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('marketplace', () =>
          tx.marketplace.create({
            data: {
              id: input.id ?? newId(),
              slug: input.slug,
              displayName: input.displayName,
              description: input.description ?? null,
              ownerTeamId: input.ownerTeamId ?? null,
              audience: toJson(input.audience),
              desktopInstallation: input.desktopInstallation ?? 'available',
              mirror: toJsonOrNull(mirror),
              createdBy: input.createdBy,
            },
          }),
        );
        unit.audit(audit, {
          action: 'marketplace.create',
          targetType: 'marketplace',
          targetId: row.id,
          diff: { before: null, after: { slug: row.slug } },
        });
        return toMarketplaceView(row);
      });
    },

    async update(
      id: string,
      patch: Partial<
        Pick<
          CreateMarketplaceInput,
          | 'displayName'
          | 'description'
          | 'ownerTeamId'
          | 'audience'
          | 'desktopInstallation'
          | 'mirror'
        >
      >,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<MarketplaceView> {
      const mirror =
        patch.mirror === undefined || patch.mirror === null
          ? patch.mirror
          : mirrorTargetSchema.parse(patch.mirror);
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'marketplace',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.marketplace.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { audience, mirror: _m, ...rest } = patch;
            return tx.marketplace.updateMany({
              where,
              data: {
                ...rest,
                ...(audience === undefined ? {} : { audience: toJson(audience) }),
                ...(mirror === undefined ? {} : { mirror: toJsonOrNull(mirror) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.marketplace.findUniqueOrThrow({ where: { id } }),
        });
        unit.audit(opts.audit, {
          action: 'marketplace.update',
          targetType: 'marketplace',
          targetId: id,
          diff: { before: toMarketplaceView(current), after: toMarketplaceView(row) },
        });
        return toMarketplaceView(row);
      });
    },

    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.marketplace.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('marketplace', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.marketplace.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.audit(opts.audit, {
          action: 'marketplace.delete',
          targetType: 'marketplace',
          targetId: id,
          diff: { before: { slug: current.slug }, after: null },
        });
      });
    },

    async listItems(
      marketplaceId: string,
    ): Promise<(MarketplaceItemInput & { position: number })[]> {
      const rows = await db.marketplaceItem.findMany({
        where: { marketplaceId },
        orderBy: { position: 'asc' },
      });
      return rows.map((r) => ({
        catalogEntryId: r.catalogEntryId,
        policy: policySchema.parse(r.policy),
        pinnedVersionId: r.pinnedVersionId,
        position: r.position,
      }));
    },

    /** Replaces the item list; array order becomes `position`. Pinned versions must belong to their entry. */
    replaceItems(
      marketplaceId: string,
      items: readonly MarketplaceItemInput[],
      audit?: AuditContext,
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const exists = await tx.marketplace.count({ where: { id: marketplaceId } });
        if (exists === 0) throw new NotFoundError('marketplace', marketplaceId);
        if (new Set(items.map((i) => i.catalogEntryId)).size !== items.length) {
          throw new ValidationError('duplicate catalog entry in marketplace');
        }
        for (const item of items) {
          if (!item.pinnedVersionId) continue;
          const v = await tx.catalogVersion.findUnique({
            where: { id: item.pinnedVersionId },
            select: { entryId: true },
          });
          if (v?.entryId !== item.catalogEntryId) {
            throw new ValidationError('pinned version does not belong to the entry', {
              entry: item.catalogEntryId,
            });
          }
        }
        await tx.marketplaceItem.deleteMany({ where: { marketplaceId } });
        if (items.length > 0) {
          await tx.marketplaceItem.createMany({
            data: items.map((i, position) => ({
              marketplaceId,
              catalogEntryId: i.catalogEntryId,
              policy: i.policy,
              pinnedVersionId: i.pinnedVersionId ?? null,
              position,
            })),
          });
        }
        unit.audit(audit, {
          action: 'marketplace.items.replace',
          targetType: 'marketplace',
          targetId: marketplaceId,
          diff: {
            before: null,
            after: { items: items.map((i) => ({ entry: i.catalogEntryId, policy: i.policy })) },
          },
        });
      });
    },
  };
};

// --- MarketplaceStore port ---------------------------------------------------------------------------------------------------

export type PluginFileRow = {
  path: string;
  content: Uint8Array;
  mode: (typeof FILE_MODES)[number];
};

/** What the injected assembler receives to build a release item (manifest parsing lives in `@bastion-mcp/plugins`). */
export type ReleaseItemSource = {
  entry: { id: string; slug: string; displayName: string; kind: string };
  version: { id: string; label: string };
  policy: ItemPolicy;
  files: PluginFileRow[];
  /** Resolves a skill reference (by entry slug) to its current or pinned version files. */
  loadSkillFiles(
    entrySlug: string,
    versionLabel?: string,
  ): Promise<{ slug: string; files: PluginFileRow[] } | null>;
};

export type MarketplaceStoreDeps<TItem> = {
  /** Builds a `ReleaseItem` (`importPluginTree` of `@bastion-mcp/plugins`) from a version's file tree. */
  assemble: (source: ReleaseItemSource) => TItem | Promise<TItem>;
  /** Owner shown in manifests when the marketplace has no owner team; defaults to the org display name. */
  defaultOwnerName?: () => Promise<string>;
};

/**
 * `MarketplaceStore` of `@bastion-mcp/plugins`. The generic `TItem` is the plugins package's `ReleaseItem`; db only
 * loads rows and files, the injected `assemble` parses them.
 */
export const createMarketplaceStore = <
  TItem extends { name: string; version: string; policy: ItemPolicy },
>(
  arg: PrismaLike | RepoContext,
  deps: MarketplaceStoreDeps<TItem>,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const toRow = async (row: MarketplaceDbRow): Promise<MarketplaceRow> => {
    const view = toMarketplaceView(row);
    let ownerName = deps.defaultOwnerName ? await deps.defaultOwnerName() : 'Bastion';
    if (row.ownerTeamId) {
      const team = await db.team.findUnique({
        where: { id: row.ownerTeamId },
        select: { displayName: true },
      });
      if (team) ownerName = team.displayName;
    }
    return {
      id: view.id,
      slug: view.slug,
      displayName: view.displayName,
      ...(view.description === null ? {} : { description: view.description }),
      ownerName,
      desktopInstallation: view.desktopInstallation,
      promotedRelease: view.promotedRelease,
      mirror: view.mirror,
      mirrorStatus: view.mirrorStatus,
    };
  };

  const loadFiles = async (versionId: string): Promise<PluginFileRow[]> => {
    const rows = await db.catalogFile.findMany({
      where: { catalogVersionId: versionId },
      include: { blobSha256Rel: { select: { content: true } } },
      orderBy: { path: 'asc' },
    });
    return rows.map((r) => ({
      path: r.path,
      content: new Uint8Array(r.blobSha256Rel.content),
      mode: fileModeSchema.parse(r.mode),
    }));
  };

  const loadSkillFiles = async (entrySlug: string, versionLabel?: string) => {
    const entry = await db.catalogEntry.findUnique({ where: { slug: entrySlug } });
    if (!entry) return null;
    const version = versionLabel
      ? await db.catalogVersion.findUnique({
          where: { entryId_label: { entryId: entry.id, label: versionLabel } },
        })
      : entry.currentVersionId
        ? await db.catalogVersion.findUnique({ where: { id: entry.currentVersionId } })
        : null;
    if (!version) return null;
    return { slug: entry.slug, files: await loadFiles(version.id) };
  };

  const assembleFor = async (
    entryId: string,
    versionId: string,
    policy: ItemPolicy,
  ): Promise<TItem & { entryId: string; versionId: string }> => {
    const entry = await db.catalogEntry.findUnique({ where: { id: entryId } });
    const version = await db.catalogVersion.findUnique({ where: { id: versionId } });
    if (!entry || !version) throw new NotFoundError('catalog version', versionId);
    const item = await deps.assemble({
      entry: { id: entry.id, slug: entry.slug, displayName: entry.displayName, kind: entry.kind },
      version: { id: version.id, label: version.label },
      policy,
      files: await loadFiles(versionId),
      loadSkillFiles,
    });
    return { ...item, entryId, versionId };
  };

  return {
    async getBySlug(slug: string): Promise<MarketplaceRow | undefined> {
      const row = await db.marketplace.findUnique({ where: { slug } });
      return row ? toRow(row) : undefined;
    },
    async getById(id: string): Promise<MarketplaceRow | undefined> {
      const row = await db.marketplace.findUnique({ where: { id } });
      return row ? toRow(row) : undefined;
    },

    /** Items now, follow-current and pinned versions resolved and files loaded, in position order. */
    async resolveItems(
      marketplaceId: string,
    ): Promise<(TItem & { entryId: string; versionId: string })[]> {
      const items = await db.marketplaceItem.findMany({
        where: { marketplaceId },
        include: { catalogEntry: { select: { currentVersionId: true, status: true } } },
        orderBy: { position: 'asc' },
      });
      const out: (TItem & { entryId: string; versionId: string })[] = [];
      for (const item of items) {
        const versionId = item.pinnedVersionId ?? item.catalogEntry.currentVersionId;
        if (!versionId || item.catalogEntry.status === 'archived') continue;
        out.push(
          await assembleFor(item.catalogEntryId, versionId, policySchema.parse(item.policy)),
        );
      }
      return out;
    },

    /** The content of a past release, from the `{entryId, versionId, policy}` rows it recorded. */
    async loadReleaseItems(marketplaceId: string, seq: number): Promise<TItem[]> {
      const release = await db.marketplaceRelease.findUnique({
        where: { marketplaceId_seq: { marketplaceId, seq } },
      });
      if (!release) throw new NotFoundError('release', `${marketplaceId}#${seq}`);
      const refs = releaseItemsSchema.parse(release.items);
      const out: TItem[] = [];
      for (const ref of refs) out.push(await assembleFor(ref.entryId, ref.versionId, ref.policy));
      return out;
    },

    async setPromotedRelease(
      marketplaceId: string,
      seq: number,
      audit?: AuditContext,
    ): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const release = await tx.marketplaceRelease.count({ where: { marketplaceId, seq } });
        if (release === 0) throw new NotFoundError('release', `${marketplaceId}#${seq}`);
        const before = await tx.marketplace.findUniqueOrThrow({ where: { id: marketplaceId } });
        await tx.marketplace.update({
          where: { id: marketplaceId },
          data: { promotedRelease: seq },
        });
        unit.audit(audit, {
          action: 'marketplace.promote',
          targetType: 'marketplace',
          targetId: marketplaceId,
          diff: {
            before: { promotedRelease: before.promotedRelease },
            after: { promotedRelease: seq },
          },
        });
      });
    },

    async setMirrorStatus(marketplaceId: string, state: MirrorState): Promise<void> {
      await db.marketplace.update({
        where: { id: marketplaceId },
        data: { mirrorStatus: toJson(mirrorStateSchema.parse(state)) },
      });
    },
  };
};

// --- ReleaseStore port -------------------------------------------------------------------------------------------------------

/** `ReleaseStore`: releases are immutable; `insert` throws when `(marketplaceId, seq)` exists. */
export const createReleaseStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const toRecord = (row: {
    seq: number;
    items: unknown;
    gitCommit: string;
    claudeManifestSha256: Uint8Array;
    agentsManifestSha256: Uint8Array;
    archives: unknown;
    createdAt: Date;
  }): ReleaseRecord => ({
    seq: row.seq,
    items: releaseItemsSchema
      .parse(row.items)
      .map((i) => ({ name: i.name, version: i.version, policy: i.policy })),
    gitCommit: row.gitCommit,
    claudeManifestSha256: bytesToHex(row.claudeManifestSha256),
    agentsManifestSha256: bytesToHex(row.agentsManifestSha256),
    archives: archivesSchema.parse(row.archives),
    releaseTime: row.createdAt.toISOString(),
  });

  return {
    async get(marketplaceId: string, seq: number): Promise<ReleaseRecord | undefined> {
      const row = await db.marketplaceRelease.findUnique({
        where: { marketplaceId_seq: { marketplaceId, seq } },
      });
      return row ? toRecord(row) : undefined;
    },
    async latest(marketplaceId: string): Promise<ReleaseRecord | undefined> {
      const row = await db.marketplaceRelease.findFirst({
        where: { marketplaceId },
        orderBy: { seq: 'desc' },
      });
      return row ? toRecord(row) : undefined;
    },
    async list(marketplaceId: string): Promise<ReleaseRecord[]> {
      const rows = await db.marketplaceRelease.findMany({
        where: { marketplaceId },
        orderBy: { seq: 'asc' },
      });
      return rows.map(toRecord);
    },
    async insert(
      marketplaceId: string,
      record: ReleaseRecord,
      refs: ReleaseItemRef[],
      createdBy: string | null,
      audit?: AuditContext,
    ): Promise<void> {
      if (refs.length !== record.items.length) {
        throw new ValidationError('release refs and items differ in length');
      }
      const items = refs.map((ref, i) => ({
        ...ref,
        name: record.items[i]?.name ?? '',
        version: record.items[i]?.version ?? '',
      }));
      return mutate(ctx, async (tx, unit) => {
        try {
          await tx.marketplaceRelease.create({
            data: {
              marketplaceId,
              seq: record.seq,
              items: toJson(items),
              gitCommit: record.gitCommit,
              claudeManifestSha256: hexToBytes(record.claudeManifestSha256),
              agentsManifestSha256: hexToBytes(record.agentsManifestSha256),
              archives: toJson(record.archives),
              createdBy,
              createdAt: new Date(record.releaseTime),
            },
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictError('release already exists', { marketplaceId, seq: record.seq });
          }
          throw error;
        }
        unit.audit(audit, {
          action: 'marketplace.release',
          targetType: 'marketplace',
          targetId: marketplaceId,
          diff: { before: null, after: { seq: record.seq, gitCommit: record.gitCommit } },
        });
      });
    },
  };
};

// --- distribution_events sink (25.9) ---------------------------------------------------------------------------------------------

const channelSchema = z.enum(DISTRIBUTION_CHANNELS);

/** `DistributionEventSink`: inserts into the partitioned `distribution_events`, creating partitions when missing. */
export const createDistributionEventSink = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  const insert = (events: readonly DistributionEventRecord[]) =>
    db.distributionEvent.createMany({
      data: events.map((e) => ({
        id: newId(),
        ts: e.ts,
        principalId: e.principalId,
        marketplaceId: e.marketplaceId,
        releaseSeq: e.releaseSeq,
        channel: channelSchema.parse(e.channel),
        action: e.action,
        userAgent: e.userAgent,
      })),
    });
  const record = async (events: readonly DistributionEventRecord[]): Promise<void> => {
    if (events.length === 0) return;
    try {
      await insert(events);
    } catch (error) {
      if (!/no partition/i.test(String(error))) throw error;
      await ensurePartitions(db, 'distribution_events', PARTITION_DAYS_AHEAD);
      await insert(events);
    }
  };
  return {
    record: (event: DistributionEventRecord): Promise<void> => record([event]),
    recordMany: record,
  };
};

// --- plugin_sources (25.1) -----------------------------------------------------------------------------------------------------

export type PluginSourceView = {
  id: string;
  name: string;
  gitUrl: string;
  ref: string;
  path: string | null;
  authSecretId: string | null;
  tracked: boolean;
  lastCommit: string | null;
  lastSync: Record<string, unknown> | null;
  createdAt: Date;
};

const toPluginSource = (r: {
  id: string;
  name: string;
  gitUrl: string;
  ref: string;
  path: string | null;
  authSecretId: string | null;
  tracked: boolean;
  lastCommit: string | null;
  lastSync: unknown;
  createdAt: Date;
}): PluginSourceView => ({
  ...r,
  lastSync: r.lastSync === null ? null : jsonObjectSchema.parse(r.lastSync),
});

export const createPluginSourceRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<PluginSourceView | null> {
      const row = await db.pluginSource.findUnique({ where: { id } });
      return row ? toPluginSource(row) : null;
    },
    async list(): Promise<PluginSourceView[]> {
      return (await db.pluginSource.findMany({ orderBy: { name: 'asc' } })).map(toPluginSource);
    },
    create(
      input: {
        id?: string;
        name: string;
        gitUrl: string;
        ref?: string;
        path?: string | null;
        authSecretId?: string | null;
        tracked?: boolean;
      },
      audit?: AuditContext,
    ): Promise<PluginSourceView> {
      return mutate(ctx, async (tx, unit) => {
        const row = await tx.pluginSource.create({
          data: {
            id: input.id ?? newId(),
            name: input.name,
            gitUrl: input.gitUrl,
            ref: input.ref ?? 'main',
            path: input.path ?? null,
            authSecretId: input.authSecretId ?? null,
            tracked: input.tracked ?? true,
          },
        });
        unit.audit(audit, {
          action: 'plugin_source.create',
          targetType: 'plugin_source',
          targetId: row.id,
          diff: { before: null, after: { gitUrl: row.gitUrl, ref: row.ref } },
        });
        return toPluginSource(row);
      });
    },
    async recordSync(
      id: string,
      result: { lastCommit: string | null; lastSync: Record<string, unknown> },
    ): Promise<void> {
      await db.pluginSource.update({
        where: { id },
        data: { lastCommit: result.lastCommit, lastSync: toJson(result.lastSync) },
      });
    },
    delete(id: string, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.pluginSource.deleteMany({ where: { id } });
        if (res.count === 0) throw new NotFoundError('plugin source', id);
        unit.audit(audit, {
          action: 'plugin_source.delete',
          targetType: 'plugin_source',
          targetId: id,
          diff: { before: { id }, after: null },
        });
      });
    },
  };
};

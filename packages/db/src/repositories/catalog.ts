import { createHash } from 'node:crypto';
import {
  CATALOG_KINDS,
  CATALOG_STATUSES,
  CATALOG_VERSION_STATUSES,
  DRIFT_POLICIES,
  FILE_CLASSIFICATIONS,
  FILE_MODES,
  newId,
  RISK_LEVELS,
  type ServerSpec,
  serverSpecSchema,
  USER_OVERRIDE_LEVELS,
} from '@bastion-mcp/core';
import { z } from 'zod';
import type { CatalogEntry, CatalogVersion, Prisma } from '../generated/client';
import {
  type AuditContext,
  afterIdDesc,
  assertIfMatch,
  assertSwapped,
  bytesToHex,
  ConflictError,
  clampLimit,
  decodeCursor,
  encodeCursor,
  etagOf,
  hexToBytes,
  idCursorOf,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  nextUpdatedAt,
  orConflict,
  type Paged,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toBytes,
  toContext,
  toJson,
  toJsonOrNull,
  toPage,
  type Tx,
  ValidationError,
  versionGuard,
} from './support';

// --- shapes ---------------------------------------------------------------------------------------------------------

/** Who may see a catalog entry (11.1, `visibilitySchema` of `@bastion-mcp/policy`). */
export const visibilitySchema = z.object({
  org: z.boolean().default(false),
  teamIds: z.array(z.string()).default([]),
  userIds: z.array(z.string()).default([]),
});
export type CatalogVisibility = z.infer<typeof visibilitySchema>;

export type CatalogEntryView = {
  id: string;
  slug: string;
  kind: (typeof CATALOG_KINDS)[number];
  displayName: string;
  description: string;
  hasIcon: boolean;
  tags: string[];
  ownerTeamId: string | null;
  visibility: CatalogVisibility;
  status: (typeof CATALOG_STATUSES)[number];
  risk: (typeof RISK_LEVELS)[number];
  source: Record<string, unknown>;
  currentVersionId: string | null;
  autoUpgrade: boolean;
  userOverrides: (typeof USER_OVERRIDE_LEVELS)[number];
  onDrift: (typeof DRIFT_POLICIES)[number];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const kindSchema = z.enum(CATALOG_KINDS);
const statusSchema = z.enum(CATALOG_STATUSES);
const riskSchema = z.enum(RISK_LEVELS);
const overridesLevel = z.enum(USER_OVERRIDE_LEVELS);
const driftSchema = z.enum(DRIFT_POLICIES);
const versionStatus = z.enum(CATALOG_VERSION_STATUSES);

export const toEntryView = (row: CatalogEntry): CatalogEntryView => ({
  id: row.id,
  slug: row.slug,
  kind: kindSchema.parse(row.kind),
  displayName: row.displayName,
  description: row.description,
  hasIcon: row.iconBlob !== null,
  tags: row.tags,
  ownerTeamId: row.ownerTeamId,
  visibility: visibilitySchema.parse(row.visibility),
  status: statusSchema.parse(row.status),
  risk: riskSchema.parse(row.risk),
  source: jsonObjectSchema.parse(row.source),
  currentVersionId: row.currentVersionId,
  autoUpgrade: row.autoUpgrade,
  userOverrides: overridesLevel.parse(row.userOverrides),
  onDrift: driftSchema.parse(row.onDrift),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Catalog flags the runtime reads from a version (6.4, 6.8, 8.6). */
export const versionRuntimeSchema = z
  .object({
    enableSampling: z.boolean().default(false),
    enableRoots: z.boolean().default(false),
    roots: z.array(z.string()).optional(),
    extensions: z
      .object({ allow: z.array(z.string()).optional(), block: z.array(z.string()).optional() })
      .default({}),
    replicas: z.number().int().min(1).max(10).default(1),
    listTtlMs: z.number().int().positive().optional(),
  })
  .default({
    enableSampling: false,
    enableRoots: false,
    extensions: {},
    replicas: 1,
  });
export type VersionRuntime = z.infer<typeof versionRuntimeSchema>;

export type CatalogVersionView = {
  id: string;
  entryId: string;
  label: string;
  serverSpec: unknown;
  overrides: Record<string, unknown>;
  guardProfileId: string | null;
  limits: unknown[];
  installForm: Record<string, unknown>;
  lockfile: unknown;
  referenceSnapshotId: string | null;
  protocolEra: string | null;
  testResult: unknown;
  runtime: VersionRuntime;
  status: (typeof CATALOG_VERSION_STATUSES)[number];
  changelog: string | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
};

export const toVersionView = (row: CatalogVersion): CatalogVersionView => ({
  id: row.id,
  entryId: row.entryId,
  label: row.label,
  serverSpec: row.serverSpec,
  overrides: jsonObjectSchema.parse(row.overrides),
  guardProfileId: row.guardProfileId,
  limits: z.array(z.unknown()).parse(row.limits),
  installForm: jsonObjectSchema.parse(row.installForm),
  lockfile: row.lockfile,
  referenceSnapshotId: row.referenceSnapshotId,
  protocolEra: row.protocolEra,
  testResult: row.testResult,
  runtime: versionRuntimeSchema.parse(row.runtime),
  status: versionStatus.parse(row.status),
  changelog: row.changelog,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  publishedAt: row.publishedAt,
});

// --- full-text search document (11.2) ---------------------------------------------------------------------------------

export type SearchParts = {
  name: string;
  slug: string;
  description: string;
  tags: readonly string[];
  tools: readonly { name: string; description?: string | undefined }[];
};

const MAX_TOOLS_TEXT = 20_000;

const toolEntry = z.object({ name: z.string(), description: z.string().optional() });

/** Reads tool names and descriptions from a snapshot's `tools` JSON; tolerates malformed items. */
export const toolsOfSnapshot = (tools: unknown): SearchParts['tools'] => {
  if (!Array.isArray(tools)) return [];
  const out: { name: string; description?: string | undefined }[] = [];
  for (const t of tools) {
    const parsed = toolEntry.safeParse(t);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
};

/** The four weighted texts that feed `to_tsvector('simple', ...)`: name A, tags B, description C, tools D. */
export const buildCatalogSearchTexts = (parts: SearchParts) => ({
  a: `${parts.name} ${parts.slug.replace(/-/g, ' ')}`,
  b: parts.tags.join(' '),
  c: parts.description,
  d: parts.tools
    .map((t) => `${t.name.replace(/[_.-]/g, ' ')} ${t.description ?? ''}`)
    .join(' ')
    .slice(0, MAX_TOOLS_TEXT),
});

/** Recomputes `catalog_entries.search` from the entry and its current version's reference snapshot. */
export const reindexCatalogSearch = async (tx: Tx, entryId: string): Promise<void> => {
  const entry = await tx.catalogEntry.findUnique({ where: { id: entryId } });
  if (!entry) return;
  let tools: SearchParts['tools'] = [];
  if (entry.currentVersionId) {
    const version = await tx.catalogVersion.findUnique({
      where: { id: entry.currentVersionId },
      select: { referenceSnapshotId: true },
    });
    if (version?.referenceSnapshotId) {
      const snapshot = await tx.upstreamSnapshot.findUnique({
        where: { id: version.referenceSnapshotId },
        select: { tools: true },
      });
      tools = toolsOfSnapshot(snapshot?.tools);
    }
  }
  const t = buildCatalogSearchTexts({
    name: entry.displayName,
    slug: entry.slug,
    description: entry.description,
    tags: entry.tags,
    tools,
  });
  await tx.$executeRaw`
    UPDATE catalog_entries SET search =
      setweight(to_tsvector('simple', ${t.a}), 'A') ||
      setweight(to_tsvector('simple', ${t.b}), 'B') ||
      setweight(to_tsvector('simple', ${t.c}), 'C') ||
      setweight(to_tsvector('simple', ${t.d}), 'D')
    WHERE id = ${entryId}::uuid`;
};

// --- entries ------------------------------------------------------------------------------------------------------------

export type CreateCatalogEntryInput = {
  id?: string;
  slug: string;
  kind?: CatalogEntryView['kind'];
  displayName: string;
  description: string;
  icon?: Uint8Array | null;
  tags?: string[];
  ownerTeamId?: string | null;
  visibility?: Partial<CatalogVisibility>;
  risk?: CatalogEntryView['risk'];
  source?: Record<string, unknown>;
  autoUpgrade?: boolean;
  userOverrides?: CatalogEntryView['userOverrides'];
  onDrift?: CatalogEntryView['onDrift'];
  createdBy: string;
};

export type UpdateCatalogEntryInput = Partial<
  Omit<CreateCatalogEntryInput, 'id' | 'slug' | 'createdBy'>
> & { status?: CatalogEntryView['status'] };

export type CatalogListFilter = {
  kind?: CatalogEntryView['kind'];
  status?: CatalogEntryView['status'];
  ownerTeamId?: string;
  tag?: string;
  /** Restricts to entries the user may see: org-wide, shared with a team or user, or owned by a team. */
  visibleTo?: { userId: string; teamIds: readonly string[] };
  limit?: number;
  cursor?: string;
};

const visibleToWhere = (v: NonNullable<CatalogListFilter['visibleTo']>): Prisma.CatalogEntryWhereInput => ({
  OR: [
    { visibility: { path: ['org'], equals: true } },
    { visibility: { path: ['userIds'], array_contains: [v.userId] } },
    ...v.teamIds.map((t) => ({ visibility: { path: ['teamIds'], array_contains: [t] } })),
    ...(v.teamIds.length > 0 ? [{ ownerTeamId: { in: [...v.teamIds] } }] : []),
  ],
});

/** `catalog_entries` CRUD and search (11.1, 11.2) with the `search` tsvector maintained on every write. */
export const createCatalogEntryRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const baseWhere = (f: CatalogListFilter): Prisma.CatalogEntryWhereInput => ({
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.ownerTeamId ? { ownerTeamId: f.ownerTeamId } : {}),
    ...(f.tag ? { tags: { has: f.tag } } : {}),
    ...(f.visibleTo ? visibleToWhere(f.visibleTo) : {}),
  });

  return {
    async get(id: string): Promise<CatalogEntryView | null> {
      const row = await db.catalogEntry.findUnique({ where: { id } });
      return row ? toEntryView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ entry: CatalogEntryView; etag: string } | null> {
      const row = await db.catalogEntry.findUnique({ where: { id } });
      return row ? { entry: toEntryView(row), etag: etagOf(row) } : null;
    },
    async getBySlug(slug: string): Promise<CatalogEntryView | null> {
      const row = await db.catalogEntry.findUnique({ where: { slug } });
      return row ? toEntryView(row) : null;
    },
    async getIcon(id: string): Promise<Uint8Array | null> {
      const row = await db.catalogEntry.findUnique({ where: { id }, select: { iconBlob: true } });
      return row?.iconBlob ?? null;
    },

    async list(filter: CatalogListFilter = {}): Promise<Paged<CatalogEntryView>> {
      const limit = clampLimit(filter.limit);
      const rows = await db.catalogEntry.findMany({
        where: { AND: [baseWhere(filter), afterIdDesc(filter.cursor)] },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = toPage(rows, limit, idCursorOf);
      return { items: page.items.map(toEntryView), nextCursor: page.nextCursor };
    },

    /**
     * Ranked full-text search over name, tags, description and reference-snapshot tools (11.2). The cursor is
     * an offset, since rank order has no stable keyset.
     */
    async search(
      query: string,
      filter: Omit<CatalogListFilter, 'cursor'> & { cursor?: string } = {},
    ): Promise<Paged<CatalogEntryView>> {
      const limit = clampLimit(filter.limit);
      const offset = Number(decodeCursor(filter.cursor)?.[0] ?? 0);
      if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('invalid cursor');
      const allowed = await db.catalogEntry.findMany({ where: baseWhere(filter), select: { id: true } });
      if (allowed.length === 0) return { items: [], nextCursor: null };
      const ids = allowed.map((r) => r.id);
      const ranked = await db.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM catalog_entries
        WHERE id = ANY(${ids}::uuid[]) AND search @@ websearch_to_tsquery('simple', ${query})
        ORDER BY ts_rank(search, websearch_to_tsquery('simple', ${query})) DESC, id DESC
        LIMIT ${limit + 1} OFFSET ${offset}`;
      const rows = await db.catalogEntry.findMany({ where: { id: { in: ranked.map((r) => r.id) } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ranked.flatMap((r) => {
        const row = byId.get(r.id);
        return row ? [row] : [];
      });
      const hasMore = ordered.length > limit;
      return {
        items: ordered.slice(0, limit).map(toEntryView),
        nextCursor: hasMore ? encodeCursor([offset + limit]) : null,
      };
    },

    /** Rebuilds the tsvector, for example after the reference snapshot of the current version changed. */
    async reindexSearch(entryId: string): Promise<void> {
      await mutate(ctx, (tx) => reindexCatalogSearch(tx, entryId));
    },

    async create(input: CreateCatalogEntryInput, audit?: AuditContext): Promise<CatalogEntryView> {
      const visibility = visibilitySchema.parse(input.visibility ?? {});
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('catalog entry', () =>
          tx.catalogEntry.create({
            data: {
              id: input.id ?? newId(),
              slug: input.slug,
              kind: input.kind ?? 'mcp_server',
              displayName: input.displayName,
              description: input.description,
              iconBlob: input.icon ? toBytes(input.icon) : null,
              tags: input.tags ?? [],
              ownerTeamId: input.ownerTeamId ?? null,
              visibility: toJson(visibility),
              risk: input.risk ?? 'medium',
              source: toJson(input.source ?? { type: 'manual' }),
              autoUpgrade: input.autoUpgrade ?? true,
              userOverrides: input.userOverrides ?? 'cosmetic',
              onDrift: input.onDrift ?? 'hideChanged',
              createdBy: input.createdBy,
            },
          }),
        );
        await reindexCatalogSearch(tx, row.id);
        unit.bump('catalog', row.id);
        unit.audit(audit, {
          action: 'catalog.entry.create',
          targetType: 'catalog_entry',
          targetId: row.id,
          diff: { before: null, after: { slug: row.slug, kind: row.kind } },
        });
        return toEntryView(row);
      });
    },

    async update(
      id: string,
      patch: UpdateCatalogEntryInput,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<CatalogEntryView> {
      const visibility =
        patch.visibility === undefined ? undefined : visibilitySchema.parse(patch.visibility);
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogEntry.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog entry', id);
        assertIfMatch(current, opts.ifMatch);
        const { icon, visibility: _v, source, ...rest } = patch;
        assertSwapped(
          await tx.catalogEntry.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(icon === undefined ? {} : { iconBlob: icon === null ? null : toBytes(icon) }),
              ...(visibility === undefined ? {} : { visibility: toJson(visibility) }),
              ...(source === undefined ? {} : { source: toJson(source) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        await reindexCatalogSearch(tx, id);
        const row = await tx.catalogEntry.findUniqueOrThrow({ where: { id } });
        unit.bump('catalog', id);
        unit.audit(opts.audit, {
          action: patch.status ? `catalog.entry.${patch.status}` : 'catalog.entry.update',
          targetType: 'catalog_entry',
          targetId: id,
          diff: { before: toEntryView(current), after: toEntryView(row) },
        });
        return toEntryView(row);
      });
    },

    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogEntry.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog entry', id);
        assertIfMatch(current, opts.ifMatch);
        const used = await tx.installation.count({ where: { catalogEntryId: id } });
        if (used > 0) throw new ConflictError('catalog entry has installations', { installations: used });
        assertSwapped(await tx.catalogEntry.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('catalog', id);
        unit.audit(opts.audit, {
          action: 'catalog.entry.delete',
          targetType: 'catalog_entry',
          targetId: id,
          diff: { before: { slug: current.slug }, after: null },
        });
      });
    },
  };
};

// --- versions ----------------------------------------------------------------------------------------------------------

export type CreateCatalogVersionInput = {
  id?: string;
  entryId: string;
  label: string;
  serverSpec: unknown;
  overrides?: Record<string, unknown>;
  guardProfileId?: string | null;
  limits?: unknown[];
  installForm: Record<string, unknown>;
  lockfile?: unknown;
  referenceSnapshotId?: string | null;
  protocolEra?: string | null;
  runtime?: Partial<VersionRuntime>;
  changelog?: string | null;
  createdBy: string;
};

export type UpdateCatalogVersionInput = Partial<
  Omit<CreateCatalogVersionInput, 'id' | 'entryId' | 'label' | 'createdBy'>
>;

const validateSpec = (kind: string, spec: unknown): unknown =>
  kind === 'mcp_server' ? (serverSpecSchema.parse(spec) satisfies ServerSpec) : spec;

/** `catalog_versions` (11.1): drafts are editable, published versions are immutable. */
export const createCatalogVersionRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const entryKind = async (tx: PrismaLike, entryId: string): Promise<string> => {
    const entry = await tx.catalogEntry.findUnique({ where: { id: entryId }, select: { kind: true } });
    if (!entry) throw new NotFoundError('catalog entry', entryId);
    return entry.kind;
  };

  return {
    async get(id: string): Promise<CatalogVersionView | null> {
      const row = await db.catalogVersion.findUnique({ where: { id } });
      return row ? toVersionView(row) : null;
    },
    async getByLabel(entryId: string, label: string): Promise<CatalogVersionView | null> {
      const row = await db.catalogVersion.findUnique({ where: { entryId_label: { entryId, label } } });
      return row ? toVersionView(row) : null;
    },
    async list(entryId: string): Promise<CatalogVersionView[]> {
      const rows = await db.catalogVersion.findMany({ where: { entryId }, orderBy: { id: 'desc' } });
      return rows.map(toVersionView);
    },

    async create(input: CreateCatalogVersionInput, audit?: AuditContext): Promise<CatalogVersionView> {
      return mutate(ctx, async (tx, unit) => {
        const kind = await entryKind(tx, input.entryId);
        const spec = validateSpec(kind, input.serverSpec);
        const runtime = versionRuntimeSchema.parse(input.runtime);
        const row = await orConflict('catalog version', () =>
          tx.catalogVersion.create({
            data: {
              id: input.id ?? newId(),
              entryId: input.entryId,
              label: input.label,
              serverSpec: toJson(spec),
              overrides: toJson(input.overrides ?? {}),
              guardProfileId: input.guardProfileId ?? null,
              limits: toJson(input.limits ?? []),
              installForm: toJson(input.installForm),
              lockfile: toJsonOrNull(input.lockfile),
              referenceSnapshotId: input.referenceSnapshotId ?? null,
              protocolEra: input.protocolEra ?? null,
              runtime: toJson(runtime),
              changelog: input.changelog ?? null,
              createdBy: input.createdBy,
            },
          }),
        );
        unit.bump('catalog', input.entryId);
        unit.audit(audit, {
          action: 'catalog.version.create',
          targetType: 'catalog_version',
          targetId: row.id,
          diff: { before: null, after: { entryId: row.entryId, label: row.label } },
        });
        return toVersionView(row);
      });
    },

    update(
      id: string,
      patch: UpdateCatalogVersionInput,
      audit?: AuditContext,
    ): Promise<CatalogVersionView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogVersion.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog version', id);
        if (current.status !== 'draft') {
          throw new ConflictError('published versions are immutable', { id, status: current.status });
        }
        const kind = await entryKind(tx, current.entryId);
        const data: Prisma.CatalogVersionUncheckedUpdateInput = {};
        if (patch.serverSpec !== undefined) data.serverSpec = toJson(validateSpec(kind, patch.serverSpec));
        if (patch.overrides !== undefined) data.overrides = toJson(patch.overrides);
        if (patch.guardProfileId !== undefined) data.guardProfileId = patch.guardProfileId;
        if (patch.limits !== undefined) data.limits = toJson(patch.limits);
        if (patch.installForm !== undefined) data.installForm = toJson(patch.installForm);
        if (patch.lockfile !== undefined) data.lockfile = toJsonOrNull(patch.lockfile);
        if (patch.referenceSnapshotId !== undefined) data.referenceSnapshotId = patch.referenceSnapshotId;
        if (patch.protocolEra !== undefined) data.protocolEra = patch.protocolEra;
        if (patch.changelog !== undefined) data.changelog = patch.changelog;
        if (patch.runtime !== undefined) data.runtime = toJson(versionRuntimeSchema.parse(patch.runtime));
        const row = await tx.catalogVersion.update({ where: { id }, data });
        unit.bump('catalog', current.entryId);
        unit.audit(audit, {
          action: 'catalog.version.update',
          targetType: 'catalog_version',
          targetId: id,
          diff: { before: { keys: Object.keys(data) }, after: { keys: Object.keys(data) } },
        });
        return toVersionView(row);
      });
    },

    /** Records the sandbox test report on any version; it does not change the immutable spec. */
    async setTestResult(id: string, result: unknown): Promise<void> {
      await db.catalogVersion.update({ where: { id }, data: { testResult: toJsonOrNull(result) } });
    },

    /** Draft to published: immutable from now on, becomes the entry's current version (11.1). */
    publish(id: string, audit?: AuditContext): Promise<CatalogVersionView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogVersion.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog version', id);
        if (current.status !== 'draft') {
          throw new ConflictError('only draft versions can be published', { status: current.status });
        }
        const res = await tx.catalogVersion.updateMany({
          where: { id, status: 'draft' },
          data: { status: 'published', publishedAt: new Date() },
        });
        if (res.count !== 1) throw new ConflictError('version was published concurrently');
        const entry = await tx.catalogEntry.findUniqueOrThrow({ where: { id: current.entryId } });
        await tx.catalogEntry.update({
          where: { id: entry.id },
          data: {
            currentVersionId: id,
            ...(entry.status === 'draft' ? { status: 'published' } : {}),
          },
        });
        await reindexCatalogSearch(tx, entry.id);
        const row = await tx.catalogVersion.findUniqueOrThrow({ where: { id } });
        unit.bump('catalog', entry.id);
        unit.audit(audit, {
          action: 'catalog.version.publish',
          targetType: 'catalog_version',
          targetId: id,
          diff: { before: { status: 'draft' }, after: { status: 'published', entryId: entry.id } },
        });
        return toVersionView(row);
      });
    },

    /** A published version found unusable (11.1); installations show the problem. */
    markBroken(id: string, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogVersion.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog version', id);
        await tx.catalogVersion.update({ where: { id }, data: { status: 'broken' } });
        unit.bump('catalog', current.entryId);
        unit.audit(audit, {
          action: 'catalog.version.broken',
          targetType: 'catalog_version',
          targetId: id,
          diff: { before: { status: current.status }, after: { status: 'broken' } },
        });
      });
    },

    /** Drafts may be deleted; published versions stay while anything uses them. */
    delete(id: string, audit?: AuditContext): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.catalogVersion.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('catalog version', id);
        const used = await tx.installation.count({ where: { catalogVersionId: id } });
        if (current.status !== 'draft' || used > 0) {
          throw new ConflictError('only unused draft versions can be deleted', { status: current.status, used });
        }
        await tx.catalogVersion.delete({ where: { id } });
        unit.bump('catalog', current.entryId);
        unit.audit(audit, {
          action: 'catalog.version.delete',
          targetType: 'catalog_version',
          targetId: id,
          diff: { before: { label: current.label }, after: null },
        });
      });
    },
  };
};

// --- blobs, files and executable approvals (25.2) -----------------------------------------------------------------------

/** `BlobStore` of `@bastion-mcp/plugins`: content-addressed bodies, idempotent. */
export const createBlobStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const { db } = toContext(arg, options);
  return {
    async put(content: Uint8Array): Promise<string> {
      const sha = createHash('sha256').update(content).digest();
      await db.blob.createMany({
        data: [{ sha256: toBytes(sha), size: content.length, content: toBytes(content) }],
        skipDuplicates: true,
      });
      return sha.toString('hex');
    },
    async get(sha256: string): Promise<Uint8Array | undefined> {
      const row = await db.blob.findUnique({ where: { sha256: hexToBytes(sha256) } });
      return row ? new Uint8Array(row.content) : undefined;
    },
  };
};

export type StoredFileRow = {
  path: string;
  blobSha256: string;
  mode: (typeof FILE_MODES)[number];
  classification: (typeof FILE_CLASSIFICATIONS)[number];
};

const fileMode = z.enum(FILE_MODES);
const fileClass = z.enum(FILE_CLASSIFICATIONS);

/** `CatalogFileStore`: the file list of one version; rejects changes to published versions (11.1). */
export const createCatalogFileStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async list(catalogVersionId: string): Promise<StoredFileRow[]> {
      const rows = await db.catalogFile.findMany({
        where: { catalogVersionId },
        orderBy: { path: 'asc' },
      });
      return rows.map((r) => ({
        path: r.path,
        blobSha256: bytesToHex(r.blobSha256),
        mode: fileMode.parse(r.mode),
        classification: fileClass.parse(r.classification),
      }));
    },
    replace(catalogVersionId: string, rows: StoredFileRow[]): Promise<void> {
      return mutate(ctx, async (tx) => {
        const version = await tx.catalogVersion.findUnique({
          where: { id: catalogVersionId },
          select: { status: true },
        });
        if (!version) throw new NotFoundError('catalog version', catalogVersionId);
        if (version.status !== 'draft') {
          throw new ConflictError('files of a published version are immutable', { catalogVersionId });
        }
        await tx.catalogFile.deleteMany({ where: { catalogVersionId } });
        if (rows.length > 0) {
          await tx.catalogFile.createMany({
            data: rows.map((r) => ({
              catalogVersionId,
              path: r.path,
              blobSha256: hexToBytes(r.blobSha256),
              mode: r.mode,
              classification: r.classification,
            })),
          });
        }
      });
    },
  };
};

export type ExecutableApprovalView = {
  catalogVersionId: string;
  approvedBy: string;
  reviewedDiffSha256: string;
  note: string | null;
  approvedAt: Date;
};

/** `executable_approvals` (25.3): an admin approves the executable files of a version after reviewing the diff. */
export const createExecutableApprovalRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const view = (r: {
    catalogVersionId: string;
    approvedBy: string;
    reviewedDiffSha256: Uint8Array;
    note: string | null;
    approvedAt: Date;
  }): ExecutableApprovalView => ({
    catalogVersionId: r.catalogVersionId,
    approvedBy: r.approvedBy,
    reviewedDiffSha256: bytesToHex(r.reviewedDiffSha256),
    note: r.note,
    approvedAt: r.approvedAt,
  });
  return {
    async get(catalogVersionId: string): Promise<ExecutableApprovalView | null> {
      const row = await db.executableApproval.findUnique({ where: { catalogVersionId } });
      return row ? view(row) : null;
    },
    record(
      input: {
        catalogVersionId: string;
        approvedBy: string;
        reviewedDiffSha256: string;
        note?: string | null;
      },
      audit?: AuditContext,
    ): Promise<ExecutableApprovalView> {
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('executable approval', () =>
          tx.executableApproval.create({
            data: {
              catalogVersionId: input.catalogVersionId,
              approvedBy: input.approvedBy,
              reviewedDiffSha256: hexToBytes(input.reviewedDiffSha256),
              note: input.note ?? null,
            },
          }),
        );
        unit.audit(audit, {
          action: 'catalog.executable.approve',
          targetType: 'catalog_version',
          targetId: input.catalogVersionId,
          diff: { before: null, after: { reviewedDiffSha256: input.reviewedDiffSha256 } },
        });
        return view(row);
      });
    },
    async revoke(catalogVersionId: string, audit?: AuditContext): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const res = await tx.executableApproval.deleteMany({ where: { catalogVersionId } });
        if (res.count === 0) return;
        unit.audit(audit, {
          action: 'catalog.executable.revoke',
          targetType: 'catalog_version',
          targetId: catalogVersionId,
          diff: { before: { approved: true }, after: { approved: false } },
        });
      });
    },
  };
};

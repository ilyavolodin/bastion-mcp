import {
  AUTO_INSTALL_MODES,
  AUTO_INSTALL_SCOPES,
  INSTALLATION_STATUSES,
  isValidSlug,
  newId,
  ORG_ROLES,
  OWNER_TYPES,
  type ServerSpec,
  serverSpecSchema,
  toolPrefixFromSlug,
} from '@bastion-mcp/core';
import { z } from 'zod';
import type { Installation, Prisma } from '../generated/client';
import { type CatalogVisibility, versionRuntimeSchema, visibilitySchema } from './catalog';
import {
  type AuditContext,
  afterIdDesc,
  assertIfMatch,
  assertSwapped,
  ConflictError,
  clampLimit,
  compact,
  etagOf,
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
  type Tx,
  toContext,
  toJson,
  toJsonOrNull,
  toPage,
  ValidationError,
  versionGuard,
} from './support';

export type OwnerType = (typeof OWNER_TYPES)[number];
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

const ownerTypeSchema = z.enum(OWNER_TYPES);
const statusSchema = z.enum(INSTALLATION_STATUSES);
const stringRecord = z.record(z.string(), z.unknown());

export type InstallationView = {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  catalogEntryId: string | null;
  catalogVersionId: string | null;
  pinnedVersion: boolean;
  personalSpec: ServerSpec | null;
  slug: string;
  toolPrefix: string;
  displayName: string;
  enabled: boolean;
  variables: Record<string, unknown>;
  secretRefs: Record<string, unknown>;
  overrides: Record<string, unknown>;
  origin: string;
  status: InstallationStatus;
  statusDetail: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date | null;
};

export const toInstallationView = (row: Installation): InstallationView => ({
  id: row.id,
  ownerType: ownerTypeSchema.parse(row.ownerType),
  ownerId: row.ownerId,
  catalogEntryId: row.catalogEntryId,
  catalogVersionId: row.catalogVersionId,
  pinnedVersion: row.pinnedVersion,
  personalSpec: row.personalSpec === null ? null : serverSpecSchema.parse(row.personalSpec),
  slug: row.slug,
  toolPrefix: row.toolPrefix,
  displayName: row.displayName,
  enabled: row.enabled,
  variables: stringRecord.parse(row.variables),
  secretRefs: stringRecord.parse(row.secretRefs),
  overrides: stringRecord.parse(row.overrides),
  origin: row.origin,
  status: statusSchema.parse(row.status),
  statusDetail: row.statusDetail === null ? null : stringRecord.parse(row.statusDetail),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type CreateInstallationInput = {
  id?: string;
  ownerType: OwnerType;
  ownerId: string;
  catalogEntryId?: string | null;
  catalogVersionId?: string | null;
  pinnedVersion?: boolean;
  personalSpec?: unknown;
  slug: string;
  toolPrefix?: string;
  displayName: string;
  enabled?: boolean;
  variables?: Record<string, unknown>;
  secretRefs?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  /** `manual`, `autoInstall:<policyId>` or `registry` (11.4). */
  origin?: string;
  status?: InstallationStatus;
  statusDetail?: Record<string, unknown> | null;
};

export type UpdateInstallationInput = {
  displayName?: string;
  toolPrefix?: string;
  enabled?: boolean;
  catalogVersionId?: string | null;
  pinnedVersion?: boolean;
  variables?: Record<string, unknown>;
  secretRefs?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  status?: InstallationStatus;
  statusDetail?: Record<string, unknown> | null;
};

export type InstallationListFilter = {
  ownerType?: OwnerType;
  ownerId?: string;
  catalogEntryId?: string;
  status?: InstallationStatus;
  enabled?: boolean;
  limit?: number;
  cursor?: string;
};

const bumpOwner = (
  unit: { bump(scope: 'user' | 'team' | 'installation', id: string): void },
  row: { id: string; ownerType: string; ownerId: string },
): void => {
  unit.bump('installation', row.id);
  if (row.ownerType === 'user') unit.bump('user', row.ownerId);
  if (row.ownerType === 'team') unit.bump('team', row.ownerId);
};

/** `installations` CRUD (11.4) with ETags, audit and config bumps for the installation and its owner. */
export const createInstallationRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  return {
    async get(id: string): Promise<InstallationView | null> {
      const row = await db.installation.findUnique({ where: { id } });
      return row ? toInstallationView(row) : null;
    },
    async getWithEtag(
      id: string,
    ): Promise<{ installation: InstallationView; etag: string } | null> {
      const row = await db.installation.findUnique({ where: { id } });
      return row ? { installation: toInstallationView(row), etag: etagOf(row) } : null;
    },
    async getByOwnerSlug(
      ownerType: OwnerType,
      ownerId: string,
      slug: string,
    ): Promise<InstallationView | null> {
      const row = await db.installation.findUnique({
        where: { ownerType_ownerId_slug: { ownerType, ownerId, slug } },
      });
      return row ? toInstallationView(row) : null;
    },

    async list(filter: InstallationListFilter = {}): Promise<Paged<InstallationView>> {
      const limit = clampLimit(filter.limit);
      const rows = await db.installation.findMany({
        where: {
          ...(filter.ownerType ? { ownerType: filter.ownerType } : {}),
          ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
          ...(filter.catalogEntryId ? { catalogEntryId: filter.catalogEntryId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
          ...afterIdDesc(filter.cursor),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      const page = toPage(rows, limit, idCursorOf);
      return { items: page.items.map(toInstallationView), nextCursor: page.nextCursor };
    },

    async create(input: CreateInstallationInput, audit?: AuditContext): Promise<InstallationView> {
      if (!isValidSlug(input.slug))
        throw new ValidationError('invalid installation slug', { slug: input.slug });
      const hasEntry = input.catalogEntryId !== undefined && input.catalogEntryId !== null;
      const hasSpec = input.personalSpec !== undefined && input.personalSpec !== null;
      if (hasEntry === hasSpec) {
        throw new ValidationError(
          'an installation needs a catalog entry or a personal spec, not both',
        );
      }
      const personalSpec = hasSpec ? serverSpecSchema.parse(input.personalSpec) : null;
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict(
          'installation',
          () =>
            tx.installation.create({
              data: {
                id: input.id ?? newId(),
                ownerType: input.ownerType,
                ownerId: input.ownerId,
                catalogEntryId: input.catalogEntryId ?? null,
                catalogVersionId: input.catalogVersionId ?? null,
                pinnedVersion: input.pinnedVersion ?? false,
                personalSpec: toJsonOrNull(personalSpec),
                slug: input.slug,
                toolPrefix: input.toolPrefix ?? toolPrefixFromSlug(input.slug),
                displayName: input.displayName,
                enabled: input.enabled ?? true,
                variables: toJson(input.variables ?? {}),
                secretRefs: toJson(input.secretRefs ?? {}),
                overrides: toJson(input.overrides ?? {}),
                origin: input.origin ?? 'manual',
                status: input.status ?? 'ready',
                statusDetail: toJsonOrNull(input.statusDetail),
              },
            }),
          { slug: input.slug },
        );
        bumpOwner(unit, row);
        unit.audit(audit, {
          action: 'installation.create',
          targetType: 'installation',
          targetId: row.id,
          diff: {
            before: null,
            after: {
              slug: row.slug,
              ownerType: row.ownerType,
              ownerId: row.ownerId,
              origin: row.origin,
            },
          },
        });
        return toInstallationView(row);
      });
    },

    update(
      id: string,
      patch: UpdateInstallationInput,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<InstallationView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.installation.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('installation', id);
        assertIfMatch(current, opts.ifMatch);
        const { variables, secretRefs, overrides, statusDetail, ...rest } = patch;
        assertSwapped(
          await tx.installation.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(variables === undefined ? {} : { variables: toJson(variables) }),
              ...(secretRefs === undefined ? {} : { secretRefs: toJson(secretRefs) }),
              ...(overrides === undefined ? {} : { overrides: toJson(overrides) }),
              ...(statusDetail === undefined ? {} : { statusDetail: toJsonOrNull(statusDetail) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        const row = await tx.installation.findUniqueOrThrow({ where: { id } });
        bumpOwner(unit, row);
        unit.audit(opts.audit, {
          action: 'installation.update',
          targetType: 'installation',
          targetId: id,
          diff: {
            before: pickKeys(current, Object.keys(patch)),
            after: pickKeys(row, Object.keys(patch)),
          },
        });
        return toInstallationView(row);
      });
    },

    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.installation.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('installation', id);
        assertIfMatch(current, opts.ifMatch);
        await assertNotRequired(tx, current);
        assertSwapped(
          await tx.installation.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        bumpOwner(unit, current);
        unit.audit(opts.audit, {
          action: 'installation.delete',
          targetType: 'installation',
          targetId: id,
          diff: { before: { slug: current.slug, origin: current.origin }, after: null },
        });
      });
    },

    /** Per-user hide of a team installation (11.4); `required` auto-install policies cannot be hidden (11.5). */
    setHidden(
      installationId: string,
      userId: string,
      hidden: boolean,
      audit?: AuditContext,
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const inst = await tx.installation.findUnique({ where: { id: installationId } });
        if (!inst) throw new NotFoundError('installation', installationId);
        if (hidden) await assertNotRequired(tx, inst);
        await tx.installationPref.upsert({
          where: { installationId_userId: { installationId, userId } },
          create: { installationId, userId, hidden },
          update: { hidden },
        });
        unit.bump('user', userId);
        unit.audit(audit, {
          action: hidden ? 'installation.hide' : 'installation.unhide',
          targetType: 'installation',
          targetId: installationId,
          diff: { before: null, after: { userId, hidden } },
        });
      });
    },

    async listHidden(userId: string): Promise<string[]> {
      const rows = await db.installationPref.findMany({ where: { userId, hidden: true } });
      return rows.map((r) => r.installationId);
    },

    /** `InstallationStatusSink` of `mcp-upstream`. */
    async markError(
      installationId: string,
      detail: { phase: string; message: string; stderrTail: string[] },
    ): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const row = await tx.installation.findUnique({ where: { id: installationId } });
        if (!row) return;
        await tx.installation.update({
          where: { id: installationId },
          data: { status: 'error', statusDetail: toJson(detail) },
        });
        bumpOwner(unit, row);
      });
    },
    async clearError(installationId: string): Promise<void> {
      await mutate(ctx, async (tx, unit) => {
        const row = await tx.installation.findUnique({ where: { id: installationId } });
        if (row?.status !== 'error') return;
        await tx.installation.update({
          where: { id: installationId },
          data: { status: 'ready', statusDetail: toJsonOrNull(null) },
        });
        bumpOwner(unit, row);
      });
    },
  };
};

const pickKeys = (row: object, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, (row as Record<string, unknown>)[k] ?? null]));

const AUTO_PREFIX = 'autoInstall:';

/** A `required` auto-install policy pins its installations: no removal, no hiding (11.5). */
const assertNotRequired = async (tx: Tx, inst: { id: string; origin: string }): Promise<void> => {
  if (!inst.origin.startsWith(AUTO_PREFIX)) return;
  const policy = await tx.autoInstallPolicy.findUnique({
    where: { id: inst.origin.slice(AUTO_PREFIX.length) },
    select: { mode: true, enabled: true },
  });
  if (policy?.enabled && policy.mode === 'required') {
    throw new ConflictError('installation is required by an auto-install policy', { id: inst.id });
  }
};

// --- endpoints (7.1) ---------------------------------------------------------------------------------------------------

export type EndpointView = {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  slug: string;
  displayName: string;
  installationIds: string[];
  prefixMode: 'always' | 'onCollision';
  instructions: string | null;
  createdAt: Date;
  updatedAt: Date | null;
};

const prefixModeSchema = z.enum(['always', 'onCollision']);

const toEndpointView = (row: {
  id: string;
  ownerType: string;
  ownerId: string;
  slug: string;
  displayName: string;
  installationIds: string[];
  prefixMode: string;
  instructions: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}): EndpointView => ({
  id: row.id,
  ownerType: ownerTypeSchema.parse(row.ownerType),
  ownerId: row.ownerId,
  slug: row.slug,
  displayName: row.displayName,
  installationIds: row.installationIds,
  prefixMode: prefixModeSchema.parse(row.prefixMode),
  instructions: row.instructions,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** `EndpointDefinition` of `@bastion-mcp/router` for a named endpoint. */
export type EndpointDefinitionRow = {
  id: string;
  kind: 'named';
  slug: string;
  installationIds: string[];
  prefixMode: 'always' | 'onCollision';
  instructions?: string;
};

export const toEndpointDefinition = (e: EndpointView): EndpointDefinitionRow => ({
  id: e.id,
  kind: 'named',
  slug: e.slug,
  installationIds: e.installationIds,
  prefixMode: e.prefixMode,
  ...(e.instructions === null ? {} : { instructions: e.instructions }),
});

export type CreateEndpointInput = {
  id?: string;
  ownerType: OwnerType;
  ownerId: string;
  slug: string;
  displayName: string;
  installationIds: string[];
  prefixMode?: 'always' | 'onCollision';
  instructions?: string | null;
};

/** `EndpointRepository`: named endpoints, the ordered installation list sets priority (7.1). */
export const createEndpointRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const assertInstallationsExist = async (
    tx: PrismaLike,
    ids: readonly string[],
  ): Promise<void> => {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length)
      throw new ValidationError('duplicate installation in endpoint');
    const found = await tx.installation.count({ where: { id: { in: unique } } });
    if (found !== unique.length)
      throw new ValidationError('endpoint references an unknown installation');
  };

  return {
    async get(id: string): Promise<EndpointView | null> {
      const row = await db.endpoint.findUnique({ where: { id } });
      return row ? toEndpointView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ endpoint: EndpointView; etag: string } | null> {
      const row = await db.endpoint.findUnique({ where: { id } });
      return row ? { endpoint: toEndpointView(row), etag: etagOf(row) } : null;
    },
    async getBySlug(
      ownerType: OwnerType,
      ownerId: string,
      slug: string,
    ): Promise<EndpointView | null> {
      const row = await db.endpoint.findUnique({
        where: { ownerType_ownerId_slug: { ownerType, ownerId, slug } },
      });
      return row ? toEndpointView(row) : null;
    },
    /** `EndpointRepository.findDefinition`: the router's view of one endpoint. */
    async findDefinition(id: string): Promise<EndpointDefinitionRow | null> {
      const row = await db.endpoint.findUnique({ where: { id } });
      return row ? toEndpointDefinition(toEndpointView(row)) : null;
    },
    async listForOwner(ownerType: OwnerType, ownerId: string): Promise<EndpointView[]> {
      const rows = await db.endpoint.findMany({
        where: { ownerType, ownerId },
        orderBy: { slug: 'asc' },
      });
      return rows.map(toEndpointView);
    },

    async create(input: CreateEndpointInput, audit?: AuditContext): Promise<EndpointView> {
      if (!isValidSlug(input.slug))
        throw new ValidationError('invalid endpoint slug', { slug: input.slug });
      return mutate(ctx, async (tx, unit) => {
        await assertInstallationsExist(tx, input.installationIds);
        const row = await orConflict('endpoint', () =>
          tx.endpoint.create({
            data: {
              id: input.id ?? newId(),
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              slug: input.slug,
              displayName: input.displayName,
              installationIds: input.installationIds,
              prefixMode: input.prefixMode ?? 'always',
              instructions: input.instructions ?? null,
            },
          }),
        );
        unit.bump('endpoint', row.id);
        unit.audit(audit, {
          action: 'endpoint.create',
          targetType: 'endpoint',
          targetId: row.id,
          diff: { before: null, after: { slug: row.slug, installationIds: row.installationIds } },
        });
        return toEndpointView(row);
      });
    },

    update(
      id: string,
      patch: Partial<
        Pick<CreateEndpointInput, 'displayName' | 'installationIds' | 'prefixMode' | 'instructions'>
      >,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<EndpointView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.endpoint.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('endpoint', id);
        assertIfMatch(current, opts.ifMatch);
        if (patch.installationIds) await assertInstallationsExist(tx, patch.installationIds);
        assertSwapped(
          await tx.endpoint.updateMany({
            where: { id, ...versionGuard(current) },
            data: { ...patch, updatedAt: nextUpdatedAt(current) },
          }),
        );
        const row = await tx.endpoint.findUniqueOrThrow({ where: { id } });
        unit.bump('endpoint', id);
        unit.audit(opts.audit, {
          action: 'endpoint.update',
          targetType: 'endpoint',
          targetId: id,
          diff: { before: toEndpointView(current), after: toEndpointView(row) },
        });
        return toEndpointView(row);
      });
    },

    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.endpoint.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('endpoint', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.endpoint.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('endpoint', id);
        unit.audit(opts.audit, {
          action: 'endpoint.delete',
          targetType: 'endpoint',
          targetId: id,
          diff: { before: { slug: current.slug }, after: null },
        });
      });
    },
  };
};

// --- router mapping: InstallationInfo (7.2, 11.4) ------------------------------------------------------------------------------

export type InstallationOwnerInfo =
  | { kind: 'user'; id: string }
  | { kind: 'team'; id: string; slug: string }
  | { kind: 'service'; id: string; teamId?: string };

/** `InstallationInfo` of `@bastion-mcp/router`, parameterised by the overrides document type `L`. */
export type InstallationInfoRow<L = Record<string, unknown>> = {
  id: string;
  slug: string;
  toolPrefix: string;
  displayName: string;
  owner: InstallationOwnerInfo;
  enabled: boolean;
  status: 'ready' | 'needs_setup' | 'reconnect_required' | 'error' | 'disabled';
  catalogEntryId: string;
  catalogVersionId?: string;
  catalogSlug?: string;
  layers: { catalog?: L | undefined; installation?: L | undefined };
  pinned: boolean;
  capabilities: {
    tools?: boolean;
    prompts?: boolean;
    resources?: boolean;
    completions?: boolean;
    subscribe?: boolean;
  };
  needsAuth: boolean;
  policy?: {
    id: string;
    catalogEntryId: string;
    ownerUserId?: string;
    ownerTeamId?: string;
    ownerServiceId?: string;
    ownerServiceTeamId?: string;
    catalogEntry?: {
      ownerTeamId?: string;
      visibility?: CatalogVisibility;
      risk: 'low' | 'medium' | 'high';
    };
  };
};

export type PrincipalRef = { id: string; type: 'user' | 'service'; teamIds: readonly string[] };

export type RouterRepositoryOptions<L> = {
  /** Validates an overrides document read from JSONB (`overridesDocumentSchema.parse` of `@bastion-mcp/overrides`). */
  parseOverrides?: (raw: unknown) => L;
};

const authMode = (spec: unknown): string | undefined => {
  const parsed = z.object({ auth: z.object({ mode: z.string() }).optional() }).safeParse(spec);
  return parsed.success ? parsed.data.auth?.mode : undefined;
};

/**
 * The db side of the router's `InstallationInfo` (7.2): the installations a principal sees on its default
 * endpoint, with the catalog layer of overrides, the effective version (follow-current unless pinned),
 * `needsAuth` (OAuth upstream without a valid token) and policy attributes.
 *
 * Personal installations have no catalog entry; `catalogEntryId` carries the installation id so it stays a
 * unique, never-matching dependency key. Capabilities come from the newest snapshot's non-empty lists and
 * default to "everything" until a snapshot exists.
 */
export const createRouterRepository = <L = Record<string, unknown>>(
  arg: PrismaLike | RepoContext,
  options: RepoOptions & RouterRepositoryOptions<L> = {},
) => {
  const { db } = toContext(arg, options);
  const parse = (options.parseOverrides ??
    ((raw: unknown) => jsonObjectSchema.parse(raw) as L)) as (raw: unknown) => L;
  const layerOf = (raw: unknown): L | undefined => {
    const obj = jsonObjectSchema.safeParse(raw);
    return obj.success && Object.keys(obj.data).length > 0 ? parse(obj.data) : undefined;
  };

  const mapRows = async (
    rows: Prisma.InstallationGetPayload<{
      include: { catalogEntry: true; catalogVersion: true };
    }>[],
    principal: PrincipalRef,
  ): Promise<InstallationInfoRow<L>[]> => {
    const teamIds = [...new Set(rows.filter((r) => r.ownerType === 'team').map((r) => r.ownerId))];
    const teams = await db.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, slug: true },
    });
    const teamSlug = new Map(teams.map((t) => [t.id, t.slug]));
    const serviceIds = rows.filter((r) => r.ownerType === 'service').map((r) => r.ownerId);
    const accounts = await db.serviceAccount.findMany({
      where: { id: { in: serviceIds } },
      select: { id: true, teamId: true },
    });
    const serviceTeam = new Map(accounts.map((a) => [a.id, a.teamId]));
    const tokens = await db.upstreamToken.findMany({
      where: {
        principalId: principal.id,
        installationId: { in: rows.map((r) => r.id) },
        status: 'valid',
      },
      select: { installationId: true },
    });
    const hasToken = new Set(tokens.map((t) => t.installationId));
    const currentIds = rows
      .map((r) => r.catalogEntry?.currentVersionId)
      .filter((v): v is string => typeof v === 'string');
    const versions = await db.catalogVersion.findMany({ where: { id: { in: currentIds } } });
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const snapshots = await db.upstreamSnapshot.findMany({
      where: { installationId: { in: rows.map((r) => r.id) } },
      orderBy: { capturedAt: 'desc' },
      select: { installationId: true, tools: true, prompts: true, resources: true },
    });
    const snapshotOf = new Map<string, (typeof snapshots)[number]>();
    for (const s of snapshots)
      if (s.installationId && !snapshotOf.has(s.installationId))
        snapshotOf.set(s.installationId, s);
    const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

    return rows.map((r): InstallationInfoRow<L> => {
      const owner: InstallationOwnerInfo =
        r.ownerType === 'team'
          ? { kind: 'team', id: r.ownerId, slug: teamSlug.get(r.ownerId) ?? '' }
          : r.ownerType === 'service'
            ? {
                kind: 'service',
                id: r.ownerId,
                ...(serviceTeam.has(r.ownerId)
                  ? { teamId: serviceTeam.get(r.ownerId) as string }
                  : {}),
              }
            : { kind: 'user', id: r.ownerId };
      const current = r.catalogEntry?.currentVersionId
        ? versionById.get(r.catalogEntry.currentVersionId)
        : undefined;
      const version = r.pinnedVersion || !current ? r.catalogVersion : current;
      const spec = version?.serverSpec ?? r.personalSpec;
      const snap = snapshotOf.get(r.id);
      const catalogLayer = version ? layerOf(version.overrides) : undefined;
      const installationLayer = layerOf(r.overrides);
      const entry = r.catalogEntry;
      const info: InstallationInfoRow<L> = {
        id: r.id,
        slug: r.slug,
        toolPrefix: r.toolPrefix,
        displayName: r.displayName,
        owner,
        enabled: r.enabled,
        status: statusSchema.parse(r.status),
        catalogEntryId: r.catalogEntryId ?? r.id,
        ...(version ? { catalogVersionId: version.id } : {}),
        ...(entry ? { catalogSlug: entry.slug } : {}),
        layers: { catalog: catalogLayer, installation: installationLayer },
        pinned: r.pinnedVersion,
        capabilities: snap
          ? {
              tools: nonEmpty(snap.tools),
              prompts: nonEmpty(snap.prompts),
              resources: nonEmpty(snap.resources),
            }
          : { tools: true, prompts: true, resources: true },
        needsAuth: authMode(spec) === 'oauth' && !hasToken.has(r.id),
        policy: {
          id: r.id,
          catalogEntryId: r.catalogEntryId ?? r.id,
          ...(r.ownerType === 'user' ? { ownerUserId: r.ownerId } : {}),
          ...(r.ownerType === 'team' ? { ownerTeamId: r.ownerId } : {}),
          ...(r.ownerType === 'service'
            ? {
                ownerServiceId: r.ownerId,
                ...(serviceTeam.has(r.ownerId)
                  ? { ownerServiceTeamId: serviceTeam.get(r.ownerId) as string }
                  : {}),
              }
            : {}),
          ...(entry
            ? {
                catalogEntry: {
                  ...(entry.ownerTeamId ? { ownerTeamId: entry.ownerTeamId } : {}),
                  visibility: visibilitySchema.parse(entry.visibility),
                  risk: z.enum(['low', 'medium', 'high']).parse(entry.risk),
                },
              }
            : {}),
        },
      };
      return info;
    });
  };

  const include = { catalogEntry: true, catalogVersion: true } as const;

  return {
    /**
     * Installations of the principal in default-endpoint order: own first, then team installations by team, then
     * by creation (7.1). Team installations the user hid (`installation_prefs.hidden`) are left out.
     */
    async listForPrincipal(
      principal: PrincipalRef,
      opts: { includeHidden?: boolean } = {},
    ): Promise<InstallationInfoRow<L>[]> {
      const hidden =
        principal.type === 'user' && !opts.includeHidden
          ? (
              await db.installationPref.findMany({
                where: { userId: principal.id, hidden: true },
                select: { installationId: true },
              })
            ).map((p) => p.installationId)
          : [];
      const rows = await db.installation.findMany({
        where: {
          id: { notIn: hidden },
          OR: [
            { ownerType: principal.type === 'user' ? 'user' : 'service', ownerId: principal.id },
            ...(principal.teamIds.length > 0
              ? [{ ownerType: 'team', ownerId: { in: [...principal.teamIds] } }]
              : []),
          ],
        },
        include,
        orderBy: { id: 'asc' },
      });
      const rank = (r: { ownerType: string }): number => (r.ownerType === 'team' ? 1 : 0);
      rows.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
      return mapRows(rows, principal);
    },

    async getInfo(
      installationId: string,
      principal: PrincipalRef,
    ): Promise<InstallationInfoRow<L> | null> {
      const row = await db.installation.findUnique({ where: { id: installationId }, include });
      return row ? ((await mapRows([row], principal))[0] ?? null) : null;
    },

    /** `/mcp/c/{catalogSlug}` (7.1): the principal's installations of one catalog entry. */
    async listForCatalogSlug(
      principal: PrincipalRef,
      catalogSlug: string,
    ): Promise<InstallationInfoRow<L>[]> {
      const all = await this.listForPrincipal(principal);
      return all.filter((i) => i.catalogSlug === catalogSlug);
    },
  };
};

// --- mcp-upstream: ResolvedInstallation -------------------------------------------------------------------------------------------

export type ResolvedInstallationRow = {
  installationId: string;
  slug: string;
  catalogEntryId: string;
  catalogVersionId: string;
  catalogEntryName: string;
  origin: 'admin' | 'personal';
  ownerUserId: string | null;
  spec: ServerSpec;
  variables: Record<string, string>;
  configHash: string;
  enableSampling: boolean;
  enableRoots: boolean;
  roots: string[];
  extensions: { allow?: string[]; block?: string[] };
  replicas: number;
  listTtlMs?: number;
};

/**
 * `InstallationRegistry` of `@bastion-mcp/mcp-upstream`. `configHash` is `computeConfigHash` of the router, injected
 * because db may not import it.
 */
export const createInstallationRegistry = (
  arg: PrismaLike | RepoContext,
  deps: {
    configHash: (input: {
      installationId: string;
      spec: ServerSpec;
      variables: Record<string, string>;
      catalogVersionId: string;
    }) => string;
  },
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  return {
    async get(installationId: string): Promise<ResolvedInstallationRow | null> {
      const inst = await db.installation.findUnique({
        where: { id: installationId },
        include: { catalogEntry: true, catalogVersion: true },
      });
      if (!inst) return null;
      let version = inst.catalogVersion;
      const entry = inst.catalogEntry;
      if (entry && !inst.pinnedVersion && entry.currentVersionId) {
        version = await db.catalogVersion.findUnique({ where: { id: entry.currentVersionId } });
      }
      const rawSpec = version?.serverSpec ?? inst.personalSpec;
      if (rawSpec === null || rawSpec === undefined) return null;
      const spec = serverSpecSchema.parse(rawSpec);
      const variables = Object.fromEntries(
        Object.entries(stringRecord.parse(inst.variables)).map(([k, v]) => [k, String(v)]),
      );
      const runtime = versionRuntimeSchema.parse(version?.runtime ?? {});
      const versionId = version?.id ?? inst.id;
      return {
        installationId: inst.id,
        slug: inst.slug,
        catalogEntryId: inst.catalogEntryId ?? inst.id,
        catalogVersionId: versionId,
        catalogEntryName: entry?.slug ?? 'personal',
        origin: inst.personalSpec === null ? 'admin' : 'personal',
        ownerUserId: inst.ownerType === 'user' ? inst.ownerId : null,
        spec,
        variables,
        configHash: deps.configHash({
          installationId: inst.id,
          spec,
          variables,
          catalogVersionId: versionId,
        }),
        enableSampling: runtime.enableSampling,
        enableRoots: runtime.enableRoots,
        roots: runtime.roots ?? (spec.type === 'package' ? ['file:///workspace'] : []),
        extensions: compact<{ allow?: string[]; block?: string[] }>(runtime.extensions),
        replicas: runtime.replicas,
        ...(runtime.listTtlMs === undefined ? {} : { listTtlMs: runtime.listTtlMs }),
      };
    },
  };
};

// --- auto-install policies (11.5) ---------------------------------------------------------------------------------------------------------

/** Who a policy targets; present fields combine as a union (11.5). */
export const autoInstallTargetSchema = z.object({
  all: z.boolean().optional(),
  teamIds: z.array(z.string().uuid()).optional(),
  orgRoles: z.array(z.enum(ORG_ROLES)).optional(),
  idpGroups: z.array(z.string().min(1)).optional(),
});
export type AutoInstallTarget = z.infer<typeof autoInstallTargetSchema>;

export type AutoInstallPolicyView = {
  id: string;
  catalogEntryId: string;
  target: AutoInstallTarget;
  mode: (typeof AUTO_INSTALL_MODES)[number];
  scope: (typeof AUTO_INSTALL_SCOPES)[number];
  applyToExisting: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
};

const modeSchema = z.enum(AUTO_INSTALL_MODES);
const scopeSchema = z.enum(AUTO_INSTALL_SCOPES);

const toPolicyView = (row: {
  id: string;
  catalogEntryId: string;
  target: unknown;
  mode: string;
  scope: string;
  applyToExisting: boolean;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date | null;
}): AutoInstallPolicyView => ({
  id: row.id,
  catalogEntryId: row.catalogEntryId,
  target: autoInstallTargetSchema.parse(row.target),
  mode: modeSchema.parse(row.mode),
  scope: scopeSchema.parse(row.scope),
  applyToExisting: row.applyToExisting,
  enabled: row.enabled,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type AutoInstallApplicationView = {
  policyId: string;
  subjectType: 'user' | 'team';
  subjectId: string;
  installationId: string | null;
  result: string;
  appliedAt: Date;
};

export type ApplyOnceResult = {
  /** True only for the call that recorded the application and therefore ran `run`. */
  applied: boolean;
  installationId: string | null;
  result: string;
};

const subjectTypeSchema = z.enum(['user', 'team']);

const targetWhere = (target: AutoInstallTarget): Prisma.UserWhereInput => {
  if (target.all) return {};
  const or: Prisma.UserWhereInput[] = [];
  if (target.teamIds?.length)
    or.push({ teamMemberships: { some: { teamId: { in: target.teamIds } } } });
  if (target.orgRoles?.length) or.push({ orgRole: { in: target.orgRoles } });
  if (target.idpGroups?.length) {
    or.push({ teamMemberships: { some: { team: { idpGroup: { in: target.idpGroups } } } } });
  }
  return or.length === 0 ? { id: { in: [] } } : { OR: or };
};

/** `auto_install_policies` and the idempotent `auto_install_applications` ledger (11.5). */
export const createAutoInstallRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<AutoInstallPolicyView | null> {
      const row = await db.autoInstallPolicy.findUnique({ where: { id } });
      return row ? toPolicyView(row) : null;
    },
    async getWithEtag(id: string): Promise<{ policy: AutoInstallPolicyView; etag: string } | null> {
      const row = await db.autoInstallPolicy.findUnique({ where: { id } });
      return row ? { policy: toPolicyView(row), etag: etagOf(row) } : null;
    },
    async list(
      filter: { catalogEntryId?: string; enabled?: boolean } = {},
    ): Promise<AutoInstallPolicyView[]> {
      const rows = await db.autoInstallPolicy.findMany({
        where: {
          ...(filter.catalogEntryId ? { catalogEntryId: filter.catalogEntryId } : {}),
          ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toPolicyView);
    },

    async create(
      input: {
        id?: string;
        catalogEntryId: string;
        target: AutoInstallTarget;
        mode: AutoInstallPolicyView['mode'];
        scope?: AutoInstallPolicyView['scope'];
        applyToExisting?: boolean;
        enabled?: boolean;
        createdBy: string;
      },
      audit?: AuditContext,
    ): Promise<AutoInstallPolicyView> {
      const target = autoInstallTargetSchema.parse(input.target);
      return mutate(ctx, async (tx, unit) => {
        const entry = await tx.catalogEntry.findUnique({ where: { id: input.catalogEntryId } });
        if (!entry) throw new NotFoundError('catalog entry', input.catalogEntryId);
        if (entry.status !== 'published') {
          throw new ValidationError('auto-install needs a published catalog entry');
        }
        const row = await tx.autoInstallPolicy.create({
          data: {
            id: input.id ?? newId(),
            catalogEntryId: input.catalogEntryId,
            target: toJson(target),
            mode: input.mode,
            scope: input.scope ?? 'user',
            applyToExisting: input.applyToExisting ?? true,
            enabled: input.enabled ?? true,
            createdBy: input.createdBy,
          },
        });
        unit.bump('org');
        unit.audit(audit, {
          action: 'auto_install.create',
          targetType: 'auto_install_policy',
          targetId: row.id,
          diff: {
            before: null,
            after: { catalogEntryId: row.catalogEntryId, mode: row.mode, target },
          },
        });
        return toPolicyView(row);
      });
    },

    async update(
      id: string,
      patch: Partial<{
        target: AutoInstallTarget;
        mode: AutoInstallPolicyView['mode'];
        scope: AutoInstallPolicyView['scope'];
        applyToExisting: boolean;
        enabled: boolean;
      }>,
      opts: { ifMatch: string; audit?: AuditContext },
    ): Promise<AutoInstallPolicyView> {
      const target =
        patch.target === undefined ? undefined : autoInstallTargetSchema.parse(patch.target);
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.autoInstallPolicy.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('auto-install policy', id);
        assertIfMatch(current, opts.ifMatch);
        const { target: _t, ...rest } = patch;
        assertSwapped(
          await tx.autoInstallPolicy.updateMany({
            where: { id, ...versionGuard(current) },
            data: {
              ...rest,
              ...(target === undefined ? {} : { target: toJson(target) }),
              updatedAt: nextUpdatedAt(current),
            },
          }),
        );
        const row = await tx.autoInstallPolicy.findUniqueOrThrow({ where: { id } });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'auto_install.update',
          targetType: 'auto_install_policy',
          targetId: id,
          diff: { before: toPolicyView(current), after: toPolicyView(row) },
        });
        return toPolicyView(row);
      });
    },

    /** Deleting a policy keeps its installations as ordinary ones (11.5); the ledger goes with it. */
    delete(id: string, opts: { ifMatch: string; audit?: AuditContext }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.autoInstallPolicy.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('auto-install policy', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(
          await tx.autoInstallPolicy.deleteMany({ where: { id, ...versionGuard(current) } }),
        );
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'auto_install.delete',
          targetType: 'auto_install_policy',
          targetId: id,
          diff: { before: toPolicyView(current), after: null },
        });
      });
    },

    /**
     * Idempotent application: records `(policy, subjectType, subjectId)` first with `ON CONFLICT DO NOTHING`; only
     * the call that inserted the row runs `run`, in the same transaction. A removed `default` installation is
     * therefore never re-added, and concurrent triggers apply once.
     */
    applyOnce(
      key: { policyId: string; subjectType: 'user' | 'team'; subjectId: string },
      run: (ctx: RepoContext) => Promise<{ installationId: string | null; result: string }>,
    ): Promise<ApplyOnceResult> {
      return mutate(ctx, async (tx, unit) => {
        const inserted = await tx.autoInstallApplication.createMany({
          data: [
            {
              policyId: key.policyId,
              subjectType: key.subjectType,
              subjectId: key.subjectId,
              result: 'pending',
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          const existing = await tx.autoInstallApplication.findUniqueOrThrow({
            where: {
              policyId_subjectType_subjectId: {
                policyId: key.policyId,
                subjectType: key.subjectType,
                subjectId: key.subjectId,
              },
            },
          });
          return {
            applied: false,
            installationId: existing.installationId,
            result: existing.result,
          };
        }
        const outcome = await run({ ...ctx, db: tx, unit });
        await tx.autoInstallApplication.update({
          where: {
            policyId_subjectType_subjectId: {
              policyId: key.policyId,
              subjectType: key.subjectType,
              subjectId: key.subjectId,
            },
          },
          data: { installationId: outcome.installationId, result: outcome.result },
        });
        return { applied: true, installationId: outcome.installationId, result: outcome.result };
      });
    },

    async listApplications(
      policyId: string,
      filter: { subjectType?: 'user' | 'team' } = {},
    ): Promise<AutoInstallApplicationView[]> {
      const rows = await db.autoInstallApplication.findMany({
        where: { policyId, ...(filter.subjectType ? { subjectType: filter.subjectType } : {}) },
        orderBy: { appliedAt: 'asc' },
      });
      return rows.map((r) => ({ ...r, subjectType: subjectTypeSchema.parse(r.subjectType) }));
    },

    /**
     * Active users the policy targets, in id order, for the 500-user fan-out jobs; `onlyUnapplied` skips users with
     * a ledger row.
     */
    async listTargetUsers(
      policyId: string,
      opts: { afterId?: string; limit: number; onlyUnapplied?: boolean },
    ): Promise<string[]> {
      const policy = await db.autoInstallPolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new NotFoundError('auto-install policy', policyId);
      const target = autoInstallTargetSchema.parse(policy.target);
      const out: string[] = [];
      let after = opts.afterId;
      while (out.length < opts.limit) {
        const batch = await db.user.findMany({
          where: {
            status: 'active',
            AND: [targetWhere(target), ...(after ? [{ id: { gt: after } }] : [])],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: Math.max(opts.limit, 100),
        });
        if (batch.length === 0) break;
        const applied = opts.onlyUnapplied
          ? new Set(
              (
                await db.autoInstallApplication.findMany({
                  where: {
                    policyId,
                    subjectType: 'user',
                    subjectId: { in: batch.map((r) => r.id) },
                  },
                  select: { subjectId: true },
                })
              ).map((r) => r.subjectId),
            )
          : new Set<string>();
        for (const r of batch) {
          if (!applied.has(r.id)) out.push(r.id);
          if (out.length === opts.limit) break;
        }
        after = (batch[batch.length - 1] as { id: string }).id;
        if (batch.length < Math.max(opts.limit, 100)) break;
      }
      return out;
    },

    /** Teams a `team`-scope policy targets: the listed teams, or every team for `all` (11.5). */
    async listTargetTeams(policyId: string): Promise<string[]> {
      const policy = await db.autoInstallPolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new NotFoundError('auto-install policy', policyId);
      const target = autoInstallTargetSchema.parse(policy.target);
      const rows = await db.team.findMany({
        where: target.all
          ? {}
          : {
              OR: [
                ...(target.teamIds?.length ? [{ id: { in: target.teamIds } }] : []),
                ...(target.idpGroups?.length ? [{ idpGroup: { in: target.idpGroups } }] : []),
              ],
            },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => r.id);
    },

    /** Enabled policies that may apply to a newly provisioned user (JIT, SCIM, team join). */
    async listEnabledForUserScope(): Promise<AutoInstallPolicyView[]> {
      const rows = await db.autoInstallPolicy.findMany({
        where: { enabled: true, scope: 'user', catalogEntry: { status: 'published' } },
        orderBy: { id: 'asc' },
      });
      return rows.map(toPolicyView);
    },
  };
};

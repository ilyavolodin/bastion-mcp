import {
  INSTALLATION_STATUSES,
  isValidSlug,
  newId,
  OWNER_TYPES,
  type ServerSpec,
  serverSpecSchema,
  toolPrefixFromSlug,
} from '@bastion-mcp/core';
import { z } from 'zod';
import type { Installation } from '../generated/client';
import {
  type AuditContext,
  afterKey,
  assertIfMatch,
  assertSwapped,
  ConflictError,
  etagOf,
  idCursorOf,
  mutate,
  NotFoundError,
  orConflict,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  type Tx,
  toContext,
  toJson,
  toJsonOrNull,
  ValidationError,
  versionedUpdate,
  versionGuard,
} from './support';

export type OwnerType = (typeof OWNER_TYPES)[number];
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const ownerTypeSchema = z.enum(OWNER_TYPES);
export const statusSchema = z.enum(INSTALLATION_STATUSES);
export const stringRecord = z.record(z.string(), z.unknown());

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
      return paginate(
        filter,
        (take) =>
          db.installation.findMany({
            where: {
              ...(filter.ownerType ? { ownerType: filter.ownerType } : {}),
              ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
              ...(filter.catalogEntryId ? { catalogEntryId: filter.catalogEntryId } : {}),
              ...(filter.status ? { status: filter.status } : {}),
              ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toInstallationView,
      );
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
        const { current, row } = await versionedUpdate({
          what: 'installation',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.installation.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            const { variables, secretRefs, overrides, statusDetail, ...rest } = patch;
            return tx.installation.updateMany({
              where,
              data: {
                ...rest,
                ...(variables === undefined ? {} : { variables: toJson(variables) }),
                ...(secretRefs === undefined ? {} : { secretRefs: toJson(secretRefs) }),
                ...(overrides === undefined ? {} : { overrides: toJson(overrides) }),
                ...(statusDetail === undefined ? {} : { statusDetail: toJsonOrNull(statusDetail) }),
                updatedAt,
              },
            });
          },
          reload: () => tx.installation.findUniqueOrThrow({ where: { id } }),
        });
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

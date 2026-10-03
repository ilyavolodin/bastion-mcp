import { isValidSlug, newId } from '@bastion-mcp/core';
import { z } from 'zod';
import { type OwnerType, ownerTypeSchema } from './installations';
import {
  type AuditContext,
  assertIfMatch,
  assertSwapped,
  etagOf,
  mutate,
  NotFoundError,
  orConflict,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
  ValidationError,
  versionedUpdate,
  versionGuard,
} from './support';

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
        const { current, row } = await versionedUpdate({
          what: 'endpoint',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.endpoint.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            if (patch.installationIds) await assertInstallationsExist(tx, patch.installationIds);
            return tx.endpoint.updateMany({
              where,
              data: { ...patch, updatedAt },
            });
          },
          reload: () => tx.endpoint.findUniqueOrThrow({ where: { id } }),
        });
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

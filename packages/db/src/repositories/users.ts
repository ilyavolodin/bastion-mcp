import { newId, ORG_ROLES, USER_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { User } from '../generated/client';
import {
  type AuditContext,
  afterKey,
  assertIfMatch,
  assertSwapped,
  etagOf,
  idCursorOf,
  mutate,
  NotFoundError,
  nextUpdatedAt,
  orConflict,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  toContext,
  versionedUpdate,
  versionGuard,
} from './support';

export type OrgRole = (typeof ORG_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

/** A user as the API exposes it: never the password hash. */
export type UserView = {
  id: string;
  email: string;
  displayName: string;
  idpConnectionId: string | null;
  externalSubject: string | null;
  scimExternalId: string | null;
  orgRole: OrgRole;
  status: UserStatus;
  isLocal: boolean;
  catalogPublishOrgWide: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
};

const orgRoleSchema = z.enum(ORG_ROLES);
const statusSchema = z.enum(USER_STATUSES);

export const toUserView = (row: User): UserView => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  idpConnectionId: row.idpConnectionId,
  externalSubject: row.externalSubject,
  scimExternalId: row.scimExternalId,
  orgRole: orgRoleSchema.parse(row.orgRole),
  status: statusSchema.parse(row.status),
  isLocal: row.localPasswordHash !== null,
  catalogPublishOrgWide: row.catalogPublishOrgWide,
  lastLoginAt: row.lastLoginAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type CreateUserInput = {
  id?: string;
  email: string;
  displayName: string;
  orgRole?: OrgRole;
  status?: UserStatus;
  idpConnectionId?: string | null;
  externalSubject?: string | null;
  scimExternalId?: string | null;
  catalogPublishOrgWide?: boolean;
};

export type UpdateUserInput = {
  email?: string;
  displayName?: string;
  orgRole?: OrgRole;
  status?: UserStatus;
  catalogPublishOrgWide?: boolean;
};

export type UserListFilter = {
  q?: string;
  orgRole?: OrgRole;
  status?: UserStatus;
  teamId?: string;
  idpConnectionId?: string;
  limit?: number;
  cursor?: string;
};

export type WriteOptions = { audit?: AuditContext | undefined };
export type IfMatchOptions = WriteOptions & { ifMatch: string };

/** `users` CRUD for the control plane (17.2) with ETags, keyset pagination and same-transaction audit. */
export const createUserRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const require_ = async (id: string): Promise<User> => {
    const row = await db.user.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('user', id);
    return row;
  };

  return {
    async get(id: string): Promise<UserView | null> {
      const row = await db.user.findUnique({ where: { id } });
      return row ? toUserView(row) : null;
    },

    async getWithEtag(id: string): Promise<{ user: UserView; etag: string } | null> {
      const row = await db.user.findUnique({ where: { id } });
      return row ? { user: toUserView(row), etag: etagOf(row) } : null;
    },

    async findByEmail(email: string): Promise<UserView | null> {
      const row = await db.user.findUnique({ where: { email } });
      return row ? toUserView(row) : null;
    },

    async list(filter: UserListFilter = {}): Promise<Paged<UserView>> {
      const q = filter.q?.trim();
      return paginate(
        filter,
        (take) =>
          db.user.findMany({
            where: {
              ...(filter.orgRole ? { orgRole: filter.orgRole } : {}),
              ...(filter.status ? { status: filter.status } : {}),
              ...(filter.idpConnectionId ? { idpConnectionId: filter.idpConnectionId } : {}),
              ...(filter.teamId ? { teamMemberships: { some: { teamId: filter.teamId } } } : {}),
              ...(q
                ? {
                    OR: [
                      { email: { contains: q, mode: 'insensitive' } },
                      { displayName: { contains: q, mode: 'insensitive' } },
                    ],
                  }
                : {}),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toUserView,
      );
    },

    create(input: CreateUserInput, opts: WriteOptions = {}): Promise<UserView> {
      return mutate(ctx, async (tx, unit) => {
        const row = await orConflict('user', () =>
          tx.user.create({
            data: {
              id: input.id ?? newId(),
              email: input.email,
              displayName: input.displayName,
              orgRole: input.orgRole ?? 'member',
              status: input.status ?? 'active',
              idpConnectionId: input.idpConnectionId ?? null,
              externalSubject: input.externalSubject ?? null,
              scimExternalId: input.scimExternalId ?? null,
              catalogPublishOrgWide: input.catalogPublishOrgWide ?? false,
            },
          }),
        );
        unit.bump('user', row.id);
        unit.audit(opts.audit, {
          action: 'user.create',
          targetType: 'user',
          targetId: row.id,
          diff: { before: null, after: { email: row.email, orgRole: row.orgRole } },
        });
        return toUserView(row);
      });
    },

    update(id: string, patch: UpdateUserInput, opts: IfMatchOptions): Promise<UserView> {
      return mutate(ctx, async (tx, unit) => {
        const { current, row } = await versionedUpdate({
          what: 'user',
          id,
          ifMatch: opts.ifMatch,
          find: () => tx.user.findUnique({ where: { id } }),
          write: async (_current, where, updatedAt) => {
            return orConflict('user', () =>
              tx.user.updateMany({
                where,
                data: { ...patch, updatedAt },
              }),
            );
          },
          reload: () => tx.user.findUniqueOrThrow({ where: { id } }),
        });
        unit.bump('user', id);
        unit.audit(opts.audit, {
          action: patch.status === 'deactivated' ? 'user.deactivate' : 'user.update',
          targetType: 'user',
          targetId: id,
          diff: {
            before: pick(current, patch),
            after: pick(row, patch),
          },
        });
        return toUserView(row);
      });
    },

    delete(id: string, opts: IfMatchOptions): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.user.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('user', id);
        assertIfMatch(current, opts.ifMatch);
        assertSwapped(await tx.user.deleteMany({ where: { id, ...versionGuard(current) } }));
        unit.bump('user', id);
        unit.audit(opts.audit, {
          action: 'user.delete',
          targetType: 'user',
          targetId: id,
          diff: { before: { email: current.email }, after: null },
        });
      });
    },

    /** Stamps `last_login_at` without a version bump (not a configuration change). */
    async recordLogin(id: string, at: Date): Promise<void> {
      await require_(id);
      await db.user.update({ where: { id }, data: { lastLoginAt: at } });
    },

    async count(): Promise<number> {
      return db.user.count();
    },
  };
};

const pick = (row: object, patch: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(patch).map((k) => [k, (row as Record<string, unknown>)[k] ?? null]),
  );

// --- LocalAdminRepository (auth/identity/break-glass) ------------------------------------------------------

/**
 * Port `LocalAdminRepository` and its `LocalUser` row:
 * `{ id; email; orgRole: OrgRole; status: 'active'|'deactivated'; localPasswordHash: string | null }`.
 */
export const createLocalAdminRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  return {
    async findByEmail(email: string) {
      const row = await ctx.db.user.findUnique({ where: { email } });
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        orgRole: orgRoleSchema.parse(row.orgRole),
        status: statusSchema.parse(row.status),
        localPasswordHash: row.localPasswordHash,
      };
    },
    async findById(id: string) {
      const row = await ctx.db.user.findUnique({ where: { id } });
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        orgRole: orgRoleSchema.parse(row.orgRole),
        status: statusSchema.parse(row.status),
        localPasswordHash: row.localPasswordHash,
      };
    },
    /** Stores a new argon2id hash and the audit event of the change in one transaction (`LocalPasswordRepository`). */
    setPasswordHash(input: {
      userId: string;
      passwordHash: string;
      audit?: { action: string; actorType: 'user' | 'system'; actorId?: string | null };
    }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.user.findUnique({ where: { id: input.userId } });
        if (!current) throw new NotFoundError('user', input.userId);
        await tx.user.update({
          where: { id: input.userId },
          data: { localPasswordHash: input.passwordHash, updatedAt: nextUpdatedAt(current) },
        });
        unit.bump('user', input.userId);
        if (input.audit) {
          unit.audit(
            { actorType: input.audit.actorType, actorId: input.audit.actorId ?? null },
            {
              action: input.audit.action,
              targetType: 'user',
              targetId: input.userId,
              diff: { changed: ['localPasswordHash'] },
            },
          );
        }
      });
    },
    createLocalAdmin(input: {
      id: string;
      email: string;
      displayName: string;
      passwordHash: string;
    }): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        await orConflict('user', () =>
          tx.user.create({
            data: {
              id: input.id,
              email: input.email,
              displayName: input.displayName,
              orgRole: 'admin',
              localPasswordHash: input.passwordHash,
            },
          }),
        );
        unit.bump('user', input.id);
        unit.audit(
          { actorType: 'system' },
          {
            action: 'user.bootstrap_admin',
            targetType: 'user',
            targetId: input.id,
            diff: { before: null, after: { email: input.email, orgRole: 'admin' } },
          },
        );
      });
    },
  };
};

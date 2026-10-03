import {
  newId,
  ORG_SETTING_DEFAULTS,
  type OrgSettingKey,
  type OrgSettings,
  orgSettingsSchema,
  resolveOrgSettings,
} from '@bastion-mcp/core';
import { z } from 'zod';
import { getConfigVersion } from '../config-version';
import type { Notification } from '../generated/client';
import {
  type AuditContext,
  afterKey,
  assertIfMatch,
  etagOf,
  idCursorOf,
  jsonObjectSchema,
  mutate,
  nextUpdatedAt,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  ValidationError,
} from './support';

const SETTING_KEYS = Object.keys(orgSettingsSchema.shape) as OrgSettingKey[];

export const isOrgSettingKey = (key: string): key is OrgSettingKey =>
  (SETTING_KEYS as string[]).includes(key);

export type SetSettingOptions = {
  updatedBy?: string | null;
  audit?: AuditContext;
  /** When given, the stored row's ETag must match (17.1); absent for the first write of a key. */
  ifMatch?: string;
};

/**
 * `org_settings` (19.2): one row per top-level key, each validated by the `@bastion-mcp/core` zod
 * schema on write and on read. Defaults fill keys that were never written.
 */
export const createOrgSettingsRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;

  const readAll = async (): Promise<OrgSettings> => {
    const rows = await db.orgSetting.findMany();
    const stored: Partial<Record<OrgSettingKey, unknown>> = {};
    for (const row of rows) if (isOrgSettingKey(row.key)) stored[row.key] = row.value;
    return resolveOrgSettings(stored);
  };

  return {
    /** Every setting, defaults merged under stored keys. */
    getAll: readAll,

    async get<K extends OrgSettingKey>(key: K): Promise<OrgSettings[K]> {
      return (await readAll())[key];
    },

    async getWithEtag<K extends OrgSettingKey>(
      key: K,
    ): Promise<{ value: OrgSettings[K]; etag: string | null }> {
      const row = await db.orgSetting.findUnique({ where: { key } });
      const value = (await readAll())[key];
      return {
        value,
        etag: row ? etagOf({ createdAt: row.updatedAt, updatedAt: row.updatedAt }) : null,
      };
    },

    /** Validates against the core schema, upserts the key, bumps the org version. */
    async set<K extends OrgSettingKey>(
      key: K,
      value: OrgSettings[K],
      opts: SetSettingOptions = {},
    ): Promise<OrgSettings[K]> {
      if (!isOrgSettingKey(key)) throw new ValidationError('unknown setting', { key });
      const parsed = orgSettingsSchema.shape[key].safeParse(value);
      if (!parsed.success) {
        throw new ValidationError('invalid setting value', {
          key,
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return mutate(ctx, async (tx, unit) => {
        const existing = await tx.orgSetting.findUnique({ where: { key } });
        if (opts.ifMatch !== undefined && existing) {
          assertIfMatch(
            { createdAt: existing.updatedAt, updatedAt: existing.updatedAt },
            opts.ifMatch,
          );
        }
        const before = existing ? existing.value : ORG_SETTING_DEFAULTS[key];
        const now = existing
          ? nextUpdatedAt({ createdAt: existing.updatedAt, updatedAt: existing.updatedAt })
          : new Date();
        await tx.orgSetting.upsert({
          where: { key },
          create: {
            key,
            value: toJson(parsed.data),
            updatedAt: now,
            updatedBy: opts.updatedBy ?? null,
          },
          update: { value: toJson(parsed.data), updatedAt: now, updatedBy: opts.updatedBy ?? null },
        });
        unit.bump('org');
        unit.audit(opts.audit, {
          action: 'settings.update',
          targetType: 'org_setting',
          targetId: key,
          diff: { before, after: parsed.data },
        });
        return parsed.data as OrgSettings[K];
      });
    },

    /** `RegistrationSettingsSource.get` (9.3): `settings.clientRegistration`. */
    async clientRegistration(): Promise<{
      cimd: boolean;
      dcr: boolean;
      cimdHostAllowlist: readonly string[];
    }> {
      const { cimd, dcr, cimdHosts } = (await readAll()).clientRegistration;
      return { cimd, dcr, cimdHostAllowlist: cimdHosts };
    },

    /** `TokenPolicy.patMaxDays` (22.5). */
    async patMaxDays(): Promise<number> {
      return (await readAll()).tokens.patMaxDays;
    },
  };
};

// --- notifications (UI header badge) ------------------------------------------------------------------------------

export type NotificationView = {
  id: string;
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
};

const toNotification = (row: Notification): NotificationView => ({
  id: row.id,
  userId: row.userId,
  kind: row.kind,
  payload: jsonObjectSchema.parse(row.payload),
  readAt: row.readAt,
  createdAt: row.createdAt,
});

export const createNotificationRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  return {
    async create(input: {
      userId: string;
      kind: string;
      payload?: Record<string, unknown>;
    }): Promise<NotificationView> {
      const row = await db.notification.create({
        data: {
          id: newId(),
          userId: input.userId,
          kind: input.kind,
          payload: toJson(z.record(z.string(), z.unknown()).parse(input.payload ?? {})),
        },
      });
      return toNotification(row);
    },
    async list(
      userId: string,
      filter: { unreadOnly?: boolean; limit?: number; cursor?: string } = {},
    ): Promise<Paged<NotificationView>> {
      return paginate(
        filter,
        (take) =>
          db.notification.findMany({
            where: {
              userId,
              ...(filter.unreadOnly ? { readAt: null } : {}),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toNotification,
      );
    },
    async unreadCount(userId: string): Promise<number> {
      return db.notification.count({ where: { userId, readAt: null } });
    },
    /** Marks the user's own notifications read; returns how many changed. */
    async markRead(userId: string, ids: readonly string[], at: Date = new Date()): Promise<number> {
      const res = await db.notification.updateMany({
        where: { userId, id: { in: [...ids] }, readAt: null },
        data: { readAt: at },
      });
      return res.count;
    },
    async markAllRead(userId: string, at: Date = new Date()): Promise<number> {
      const res = await db.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: at },
      });
      return res.count;
    },
  };
};

// --- config_versions (4.3) ---------------------------------------------------------------------------------------------

export const createConfigVersionRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  return {
    get: (scope: string, scopeId?: string) => getConfigVersion(db, scope, scopeId),
    async list(scope?: string): Promise<{ scope: string; scopeId: string; version: bigint }[]> {
      return db.configVersion.findMany({
        ...(scope === undefined ? {} : { where: { scope } }),
        orderBy: [{ scope: 'asc' }, { scopeId: 'asc' }],
      });
    },
  };
};

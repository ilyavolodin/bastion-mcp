import { type OrgSettings, orgSettingsSchema, resolveOrgSettings } from '@bastion-mcp/core';
import { ValidationApiError } from '../errors';
import type { ApiDeps } from '../ports';
import type { WriteCtx } from './crud';

/**
 * The `settings` collection holds one row per top-level key (`id` = key, `value` = the validated document)
 * plus a `_version` row bumped on every write. The version row is the ETag of `/settings`: a missing row
 * reads as the epoch, so even the first `PATCH` must send `If-Match` (17.1).
 */
export const VERSION_ROW = '_version';
export const EPOCH = '1970-01-01T00:00:00.000Z';

export type SettingsView = { settings: OrgSettings; updatedAt: string };

export const settingsVersion = async (deps: ApiDeps): Promise<string> =>
  (await deps.store.get('settings', VERSION_ROW))?.updatedAt ?? EPOCH;

export const getSettings = async (deps: ApiDeps): Promise<SettingsView> => {
  const rows = await deps.store.find('settings', {});
  const stored: Record<string, unknown> = {};
  for (const row of rows) if (row.id !== VERSION_ROW) stored[row.id] = row.value;
  return { settings: resolveOrgSettings(stored), updatedAt: await settingsVersion(deps) };
};

const SECRET_KEY = /secret|api[-_]?key|token|password|credential|authorization/i;
const REFERENCE_KEY = /(Id|Ref)$/;

/** Settings hold references to secrets, never the values (22.3): flag inline secret-looking strings. */
export const findInlineSecrets = (value: unknown, path = ''): string[] => {
  if (Array.isArray(value)) return value.flatMap((v, i) => findInlineSecrets(v, `${path}/${i}`));
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.username || url.password) return [`${path} (URL with credentials)`];
    } catch {
      // not a URL
    }
    return [];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' &&
    child.length > 0 &&
    SECRET_KEY.test(key) &&
    !REFERENCE_KEY.test(key)
      ? [`${path}/${key}`]
      : findInlineSecrets(child, `${path}/${key}`),
  );
};

export const patchSettings = async (
  ctx: WriteCtx,
  patch: { [K in keyof OrgSettings]?: OrgSettings[K] | undefined },
): Promise<SettingsView> => {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  const errors = entries.flatMap(([key, value]) =>
    findInlineSecrets(value, `/${key}`).map((path) => ({
      path,
      message: 'store a secret reference, not the secret itself',
    })),
  );
  if (errors.length > 0) throw new ValidationApiError('settings must not contain secrets', errors);
  const profileId = patch.guards?.orgDefaultProfileId;
  if (profileId && !(await ctx.tx.store.get('guard_profiles', profileId))) {
    throw new ValidationApiError('the default guard profile does not exist', [
      { path: '/guards/orgDefaultProfileId', message: 'unknown profile' },
    ]);
  }
  for (const [key, value] of entries) {
    await ctx.tx.store.upsert('settings', key, { value });
  }
  await ctx.tx.store.upsert('settings', VERSION_ROW, { value: null });
  await ctx.tx.audit({
    action: 'settings.update',
    targetType: 'settings',
    targetId: null,
    diff: { keys: entries.map(([k]) => k), values: Object.fromEntries(entries) },
  });
  ctx.tx.configChanged('settings');
  return getSettings({ ...ctx.deps, store: ctx.tx.store });
};

/** Validates a whole-document patch: unknown keys are rejected, each key by its own schema. */
export const settingsPatchSchema = orgSettingsSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one setting is required');

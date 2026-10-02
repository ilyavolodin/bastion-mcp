import { z } from 'zod';

/** UI-managed org settings (19.2), stored in `org_settings` and validated on write and read. */
export const orgSettingsSchema = z.object({
  org: z.object({ displayName: z.string().min(1), timeZone: z.string().min(1) }),
  personalInstalls: z.enum(['off', 'remoteOnly', 'all']),
  clientRegistration: z.object({
    cimd: z.boolean(),
    dcr: z.boolean(),
    cimdHosts: z.array(z.string()),
    dcrPerIpPerHour: z.number().int().positive(),
  }),
  tokens: z.object({
    accessTtlSeconds: z.number().int().positive(),
    refreshTtlDays: z.number().int().positive(),
    refreshIdleDays: z.number().int().positive(),
    patMaxDays: z.number().int().positive(),
  }),
  logs: z.object({
    retentionDays: z.number().int().positive(),
    capturePreviews: z.boolean(),
    managerVisibility: z.boolean(),
  }),
  audit: z.object({
    retentionDays: z.number().int().positive(),
    webhookUrl: z.string().url().nullable(),
  }),
  guards: z.object({ orgDefaultProfileId: z.string().uuid().nullable() }),
  modelGuards: z.object({
    jev: z.record(z.string(), z.unknown()).nullable(),
    llmJudge: z.record(z.string(), z.unknown()).nullable(),
    classifier: z.record(z.string(), z.unknown()).nullable(),
  }),
  sandbox: z.object({
    defaultSize: z.enum(['small', 'medium', 'large']),
    warmPool: z.object({
      small: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      large: z.number().int().nonnegative(),
    }),
    idleTimeoutMinutes: z.number().int().min(1).max(1440),
  }),
  registry: z.object({ defaultSourceEnabled: z.boolean() }),
  endpoints: z.object({ toolWarnThreshold: z.number().int().positive() }),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;
export type OrgSettingKey = keyof OrgSettings;

export const ORG_SETTING_DEFAULTS: OrgSettings = {
  org: { displayName: 'Bastion', timeZone: 'UTC' },
  personalInstalls: 'remoteOnly',
  clientRegistration: { cimd: true, dcr: true, cimdHosts: [], dcrPerIpPerHour: 10 },
  tokens: { accessTtlSeconds: 900, refreshTtlDays: 30, refreshIdleDays: 7, patMaxDays: 90 },
  logs: { retentionDays: 30, capturePreviews: false, managerVisibility: true },
  audit: { retentionDays: 365, webhookUrl: null },
  guards: { orgDefaultProfileId: null },
  modelGuards: { jev: null, llmJudge: null, classifier: null },
  sandbox: {
    defaultSize: 'small',
    warmPool: { small: 5, medium: 2, large: 0 },
    idleTimeoutMinutes: 15,
  },
  registry: { defaultSourceEnabled: false },
  endpoints: { toolWarnThreshold: 40 },
};

/** Merges stored top-level keys over the defaults, validating each stored value. */
export const resolveOrgSettings = (stored: Partial<Record<OrgSettingKey, unknown>>): OrgSettings =>
  orgSettingsSchema.parse({ ...ORG_SETTING_DEFAULTS, ...stored });

import { orgSettingsSchema } from '@bastion-mcp/core';
import { z } from 'zod';
import { authz, defineMutation, defineRoute, type RouteDefinition } from '../framework/route';
import {
  EPOCH,
  getSettings,
  patchSettings,
  settingsPatchSchema,
  settingsVersion,
} from '../services/settings';
import {
  createBackup,
  getMaintenance,
  restoreBackup,
  rotateKms,
  rotateSigningKeys,
  setMaintenance,
  systemStatus,
} from '../services/system';
import { org } from './shared';

const TAG = 'Settings and system';

const settingsView = z.object({ settings: orgSettingsSchema, updatedAt: z.string() });

const statusSchema = z.object({
  replicas: z.array(
    z.object({ id: z.string(), role: z.string(), startedAt: z.string(), version: z.string() }),
  ),
  leases: z.object({
    active: z.number(),
    byInstallation: z.record(z.string(), z.number()).optional(),
  }),
  queues: z.record(
    z.string(),
    z.object({ depth: z.number(), oldestAgeSeconds: z.number().optional() }),
  ),
  driver: z.object({ name: z.string(), healthy: z.boolean(), detail: z.string().optional() }),
  registrySync: z.array(
    z.object({
      sourceId: z.string(),
      name: z.string(),
      lastSyncAt: z.string().nullable(),
      ok: z.boolean().nullable(),
      error: z.string().optional(),
    }),
  ),
  kms: z.object({
    provider: z.string(),
    healthy: z.boolean(),
    kekRef: z.string().nullable(),
    lastRotatedAt: z.string().nullable(),
  }),
  configVersion: z.string(),
});

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  since: z.string().nullable(),
  by: z.string().nullable(),
});

const restoreBodySchema = z.object({
  /** The backup file, base64. */
  data: z.string().min(1),
  passphrase: z.string().min(1),
  mode: z.enum(['merge', 'replace']),
  dryRun: z.boolean().default(false),
});

const restoreViewSchema = z.object({
  mode: z.enum(['merge', 'replace']),
  dryRun: z.boolean(),
  backup: z.object({ createdAt: z.string(), migration: z.string().nullable() }),
  tables: z.record(
    z.string(),
    z.object({
      rows: z.number(),
      existing: z.number(),
      action: z.enum(['restore', 'skip']),
      note: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
});

/** Backups arrive as base64 inside JSON: this is the largest body the API accepts (about 380 MiB of file). */
const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;

export const systemRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/settings',
    tag: TAG,
    summary: 'Organization settings (19.2); the ETag is the settings version',
    schema: { response: settingsView },
    authz: authz.on('org.view', org),
    handler: (ctx) => getSettings(ctx.deps),
  }),
  defineMutation({
    method: 'PATCH',
    url: '/settings',
    tag: TAG,
    summary: 'Replace one or more top-level settings; each key is validated on its own',
    schema: { body: settingsPatchSchema, response: settingsView },
    authz: authz.on('settings.write', org),
    version: async (input) => (await settingsVersion(input.deps)) ?? EPOCH,
    handler: (ctx) => patchSettings(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/system/status',
    tag: TAG,
    summary: 'Replicas, leases, queues, driver, registry sync and KMS',
    schema: { response: statusSchema },
    authz: authz.on('org.view', org),
    handler: (ctx) => systemStatus(ctx.deps),
  }),
  defineMutation({
    method: 'POST',
    url: '/system/kms/rotate',
    tag: TAG,
    summary: 'Rotate the key-encryption key and rewrap data keys',
    schema: { response: z.object({ kekRef: z.string(), rewrapped: z.number() }) },
    authz: authz.on('settings.write', org),
    status: 200,
    handler: (ctx) => rotateKms(ctx),
  }),
  defineMutation({
    method: 'POST',
    url: '/system/signing-keys/rotate',
    tag: TAG,
    summary: 'Rotate the authorization server signing keys',
    schema: { response: z.object({ kids: z.array(z.string()) }) },
    authz: authz.on('settings.write', org),
    status: 200,
    handler: (ctx) => rotateSigningKeys(ctx),
  }),
  defineRoute({
    method: 'POST',
    url: '/system/backup',
    tag: TAG,
    summary:
      'Create a full encrypted backup: configuration, catalog, users, installations, OAuth connections, token hashes, audit log and every secret',
    schema: {
      body: z.object({ passphrase: z.string().min(12) }),
      response: z.object({
        filename: z.string(),
        size: z.number(),
        createdAt: z.string(),
        counts: z.record(z.string(), z.number()),
        data: z.string(),
      }),
    },
    // A POST that changes no configuration: the port audits the export itself, in its own transaction.
    readOnly: true,
    authz: authz.on('settings.write', org),
    handler: (ctx) => createBackup(ctx, ctx.body.passphrase),
  }),
  defineRoute({
    method: 'POST',
    url: '/system/restore',
    tag: TAG,
    summary:
      'Restore a backup: merge (upsert by id, deletes nothing) or replace (needs maintenance mode); dryRun only reports',
    schema: { body: restoreBodySchema, response: restoreViewSchema },
    readOnly: true,
    bodyLimit: RESTORE_BODY_LIMIT,
    authz: authz.on('settings.write', org),
    handler: (ctx) => restoreBackup(ctx, ctx.body),
  }),
  defineRoute({
    method: 'GET',
    url: '/system/maintenance',
    tag: TAG,
    summary: 'Whether maintenance mode (gateway and OAuth traffic stopped) is on',
    schema: { response: maintenanceSchema },
    authz: authz.on('org.view', org),
    handler: (ctx) => getMaintenance(ctx.deps),
  }),
  defineRoute({
    method: 'POST',
    url: '/system/maintenance',
    tag: TAG,
    summary: 'Turn maintenance mode on or off on every replica',
    schema: { body: z.object({ enabled: z.boolean() }), response: maintenanceSchema },
    readOnly: true,
    authz: authz.on('settings.write', org),
    handler: (ctx) => setMaintenance(ctx, ctx.body.enabled),
  }),
];

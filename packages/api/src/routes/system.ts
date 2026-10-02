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
import { rotateKms, rotateSigningKeys, systemStatus } from '../services/system';
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
];

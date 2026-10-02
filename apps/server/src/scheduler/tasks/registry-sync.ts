import { createRegistryServerStore, createRegistrySourceStore } from '@bastion-mcp/db';
import {
  isSyncDue,
  type RegistrySource,
  serverJsonSchema,
  syncSource,
} from '@bastion-mcp/registry';
import type { TaskContext, TaskFn } from '../types';

const syncDeps = (ctx: TaskContext) => {
  const prisma = ctx.infra.db.prisma;
  return {
    serverStore: createRegistryServerStore(prisma, {
      parseServerJson: (raw: unknown) => serverJsonSchema.parse(raw),
    }),
    sourceStore: createRegistrySourceStore(prisma),
    secrets: {
      async resolve(secretId: string) {
        return (await ctx.infra.secretStore.revealById(secretId)) ?? undefined;
      },
    },
    clock: { now: ctx.now },
    ...(ctx.deps.fetch ? { fetch: ctx.deps.fetch } : {}),
  };
};

/** Syncs one source, mirroring the registry into `registry_servers` and recording `last_sync` (11.6). */
export const syncRegistrySource = async (
  ctx: TaskContext,
  source: RegistrySource,
  options: { full?: boolean } = {},
) => syncSource(source, syncDeps(ctx) as never, options);

/** Every minute: syncs each enabled source whose interval elapsed since its last attempt (11.6). */
export const registrySyncDue: TaskFn = async (ctx) => {
  const at = ctx.now();
  const sources = await ctx.infra.repos.registrySources.list();
  const synced: string[] = [];
  for (const source of sources) {
    if (!isSyncDue(source, at)) continue;
    await syncRegistrySource(ctx, source);
    synced.push(source.id);
  }
  return { synced };
};

/** Weekly: a full re-sync of every enabled source, with no `updated_since` (11.6). */
export const registryFullResync: TaskFn = async (ctx) => {
  const sources = await ctx.infra.repos.registrySources.list();
  const synced: string[] = [];
  for (const source of sources) {
    if (!source.enabled) continue;
    await syncRegistrySource(ctx, source, { full: true });
    synced.push(source.id);
  }
  return { synced };
};

/** On demand (the API's "sync now"): one source by id. */
export const registrySyncOne: TaskFn<{ sourceId: string; full?: boolean }> = async (ctx, p) => {
  const source = await ctx.infra.repos.registrySources.get(p.sourceId);
  if (!source) return { synced: [] };
  const result = await syncRegistrySource(ctx, source, p.full ? { full: true } : {});
  return { synced: [source.id], ok: result.ok };
};

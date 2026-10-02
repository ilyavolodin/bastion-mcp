import { type GuardProfile, guardProfileSchema } from '@bastion-mcp/guards';
import type { z } from 'zod';
import { ApiError, ValidationApiError } from '../errors';
import type { ApiDeps } from '../ports';
import type { Row } from '../ports/store';
import { modelGuardsSchema } from '../schemas/guards';
import { CrudService, nowIso, type ReadCtx, type WriteCtx } from './crud';

export const guardProfiles = new CrudService({
  collection: 'guard_profiles',
  targetType: 'guard_profile',
  action: 'guard_profile',
  unique: 'name',
  configTopic: 'guards',
});

/** Rebuilds the profile the guard pipeline reads from a stored row (13). */
export const profileOf = (row: Row): GuardProfile => {
  const parsed = guardProfileSchema.safeParse({ ...row, profileId: row.id });
  if (!parsed.success) {
    throw new ApiError('invalid_profile', 'the stored guard profile is invalid', 500);
  }
  return parsed.data;
};

/** Only one profile is the org default (19.2): setting it clears the flag elsewhere. */
export const createProfile = async (ctx: WriteCtx, body: Record<string, unknown>) => {
  if (body.isOrgDefault === true) await clearDefault(ctx, undefined);
  return guardProfiles.create(ctx, body);
};

export const updateProfile = async (ctx: WriteCtx, id: string, patch: Record<string, unknown>) => {
  const current = await guardProfiles.require(ctx, id);
  const merged = guardProfileSchema.safeParse({ ...current, ...patch, profileId: id });
  if (!merged.success) {
    throw new ValidationApiError(
      'the merged profile is invalid',
      merged.error.issues.map((i) => ({ path: `/${i.path.join('/')}`, message: i.message })),
    );
  }
  if (patch.isOrgDefault === true) await clearDefault(ctx, id);
  return guardProfiles.update(ctx, id, patch);
};

const clearDefault = async (ctx: WriteCtx, keep: string | undefined): Promise<void> => {
  for (const row of await ctx.tx.store.find('guard_profiles', { isOrgDefault: true })) {
    if (row.id !== keep)
      await ctx.tx.store.update('guard_profiles', row.id, { isOrgDefault: false });
  }
};

export const testProfile = async (
  ctx: { deps: ApiDeps; signal: AbortSignal },
  id: string,
  body: { text: string; phase: 'tool_input' | 'tool_output' | 'prompt' | 'resource' },
) => {
  const row = await guardProfiles.require(ctx, id);
  return ctx.deps.guards.tester.test({
    profile: profileOf(row),
    text: body.text,
    phase: body.phase,
    signal: ctx.signal,
  });
};

export type ModelGuards = z.infer<typeof modelGuardsSchema>;

const SECRET_KEY = /(api[-_]?key|secret|token|password|credential)/i;

/** Model guards reference secrets by name (`secret:NAME`); a literal value is refused (22.3). */
const findLiteralSecret = (value: unknown, path: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    const here = `${path}/${key}`;
    if (SECRET_KEY.test(key) && typeof child === 'string' && !child.startsWith('secret:')) {
      return here;
    }
    const nested = findLiteralSecret(child, here);
    if (nested) return nested;
  }
  return null;
};

const EMPTY: ModelGuards = { jev: null, llmJudge: null, classifier: null };

export const getModelGuards = async (ctx: Pick<ReadCtx, 'deps'>) => {
  const row = await ctx.deps.store.get('settings', 'modelGuards');
  const parsed = modelGuardsSchema.safeParse(row?.value ?? EMPTY);
  return { ...(parsed.success ? parsed.data : EMPTY), updatedAt: row?.updatedAt ?? null };
};

export const modelGuardsVersion = async (ctx: Pick<ReadCtx, 'deps'>): Promise<string | null> =>
  (await ctx.deps.store.get('settings', 'modelGuards'))?.updatedAt ?? null;

export const putModelGuards = async (ctx: WriteCtx, body: ModelGuards) => {
  const literal = findLiteralSecret(body, '');
  if (literal) {
    throw new ValidationApiError('reference secrets by name (secret:NAME), never by value', [
      { path: literal, message: 'literal secret value' },
    ]);
  }
  const row = await ctx.tx.store.upsert('settings', 'modelGuards', {
    value: body,
    updatedBy: ctx.principal.id,
    changedAt: nowIso(ctx.deps),
  });
  await ctx.tx.audit({
    action: 'settings.model_guards.update',
    targetType: 'setting',
    targetId: 'modelGuards',
    diff: {
      jev: body.jev !== null,
      llmJudge: body.llmJudge !== null,
      classifier: body.classifier !== null,
    },
  });
  ctx.tx.configChanged('guards');
  return { ...body, updatedAt: row.updatedAt };
};

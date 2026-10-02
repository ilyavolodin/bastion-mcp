import { redisKeys, TTL } from '@bastion-mcp/core';
import { toPipelineProfile } from '@bastion-mcp/db';
import {
  createGuardRegistry,
  type FetchLike,
  type GuardCache,
  GuardPipeline,
  type GuardProfileInput,
  guardProfileSchema,
  ORG_DEFAULT_PROFILE,
  type ProfileLayers,
  type RiskState,
  type RiskStore,
} from '@bastion-mcp/guards';
import { z } from 'zod';
import type { GuardService } from '../contracts';
import type { Infra } from '../infra';
import { watchConfig } from './config-watch';

const riskStateSchema = z.object({ score: z.number(), updatedAt: z.number() });

/** Redis-backed model-guard result cache (13.5, `guard:{instance}:{configHash}:{sha}` keys, 24 h TTL). */
export const createGuardCache = (infra: Infra): GuardCache => ({
  get: (key) => infra.redis.get(key),
  async set(key, value, ttlSeconds) {
    await infra.redis.set(key, value, 'EX', ttlSeconds || TTL.guardCache);
  },
});

/** Session risk store (13.7): `risk:{principalId}:{clientId}`, TTL 2 h. */
export const createRiskStore = (infra: Infra): RiskStore => ({
  async get(principalId, clientId) {
    const raw = await infra.redis.get(redisKeys.risk(principalId, clientId));
    if (!raw) return null;
    try {
      const parsed = riskStateSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  async set(principalId, clientId, state: RiskState) {
    await infra.redis.set(
      redisKeys.risk(principalId, clientId),
      JSON.stringify(state),
      'EX',
      TTL.riskScore,
    );
  },
});

/**
 * The guard pipeline plus the `GuardProfilePort` (13.1). Profiles are cached in memory because the port is
 * synchronous: the org default (the shipped `ORG_DEFAULT_PROFILE` until one is stored), every stored profile and the
 * profile id of each catalog version. `watch()` reloads them on `bastion:config`.
 */
export const createGuardService = (
  infra: Infra,
): GuardService & { ready(): Promise<void>; watch(): () => void } => {
  const registry = createGuardRegistry({
    fetch: (infra.options.fetch ?? fetch) as unknown as FetchLike,
    secrets: {
      resolve: async (name) => infra.vault.revealString({ scope: 'org', ownerId: null, name }),
    },
    cache: createGuardCache(infra),
  });
  const risk = createRiskStore(infra);
  const pipeline = new GuardPipeline({
    guards: registry,
    clock: infra.clock,
    riskStore: risk,
    metrics: {
      evaluation: (a) => infra.metrics.guardEvaluations.add(1, a),
      duration: (a, seconds) => infra.metrics.guardDuration.record(seconds, a),
    },
    onAsync: (result) => {
      infra.logger.info(
        { guardAsync: true, result: JSON.stringify(result).slice(0, 500) },
        'async guard result',
      );
    },
  });

  let orgProfile: GuardProfileInput = ORG_DEFAULT_PROFILE;
  const byId = new Map<string, GuardProfileInput>();
  const versionProfile = new Map<string, string>();

  const refresh = async (): Promise<void> => {
    try {
      const profiles = await infra.repos.guardProfiles.list();
      byId.clear();
      let org: GuardProfileInput | undefined;
      for (const p of profiles) {
        const parsed = guardProfileSchema.safeParse(toPipelineProfile(p));
        if (!parsed.success) {
          infra.logger.warn({ profile: p.id }, 'ignoring invalid guard profile');
          continue;
        }
        byId.set(p.id, parsed.data);
        if (p.isOrgDefault) org = parsed.data;
      }
      orgProfile = org ?? ORG_DEFAULT_PROFILE;
      versionProfile.clear();
      const rows = await infra.db.prisma.catalogVersion.findMany({
        where: { guardProfileId: { not: null } },
        select: { id: true, guardProfileId: true },
      });
      for (const row of rows)
        if (row.guardProfileId) versionProfile.set(row.id, row.guardProfileId);
    } catch (error) {
      infra.logger.warn({ err: String(error) }, 'guard profiles refresh failed; keeping previous');
    }
  };

  return {
    pipeline,
    registry,
    risk,
    profiles: {
      layersFor(input): ProfileLayers {
        const versionProfileId = input.catalogVersionId
          ? versionProfile.get(input.catalogVersionId)
          : undefined;
        return {
          org: orgProfile,
          ...(versionProfileId && byId.has(versionProfileId)
            ? { catalogVersion: byId.get(versionProfileId) }
            : {}),
          ...(input.toolProfileId && byId.has(input.toolProfileId)
            ? { tool: byId.get(input.toolProfileId) }
            : {}),
        };
      },
    },
    ready: refresh,
    watch: () => watchConfig(infra, () => void refresh()),
  };
};

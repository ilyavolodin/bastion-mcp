import type { Principal } from '@bastion-mcp/auth';
import { MS, TtlCache } from '@bastion-mcp/core';
import {
  createEndpointRepository,
  createRouterRepository,
  type EndpointDefinitionRow,
  toEndpointDefinition,
} from '@bastion-mcp/db';
import type { EndpointDataPort, PrincipalProfilePort } from '@bastion-mcp/mcp-downstream';
import { type OverridesDocument, overridesSchema } from '@bastion-mcp/overrides';
import type { EndpointDefinition, InstallationInfo } from '@bastion-mcp/router';
import type { Infra } from '../../infra';
import { watchConfig } from '../config-watch';

const REFRESH_FALLBACK_MS = 30 * MS.SECOND;
const PROFILE_TTL_MS = MS.MINUTE;
const MAX_PROFILES_CACHED = 10_000;

/**
 * `EndpointDataPort` (4.3, 7.1): what a worker loads on an endpoint-cache miss. The installations come from the db
 * router mapping (own first, then team ones; hidden ones already removed), named endpoints from the principal's own
 * and teams' endpoints. `configVersion()` is the cache-key part: the cached org-scope `config_versions` row, refreshed
 * on every `bastion:config` event and every 30 s as a safety net; finer invalidation is the event-driven
 * `EndpointCache.invalidate` (worker.ts).
 */
export const createEndpointData = (
  infra: Infra,
): EndpointDataPort & { ready(): Promise<void>; watch(): () => void } => {
  const router = createRouterRepository<OverridesDocument>(infra.db.prisma, {
    parseOverrides: (raw) => overridesSchema.parse(raw),
  });
  const endpoints = createEndpointRepository(infra.db.prisma);
  let version = '0';

  const refresh = async (): Promise<void> => {
    try {
      version = String(await infra.repos.configVersions.get('org'));
    } catch (error) {
      infra.logger.warn({ err: String(error) }, 'config version refresh failed');
    }
  };

  return {
    configVersion: () => version,
    async load(principal: Principal) {
      const ref = {
        id: principal.id,
        type: principal.type,
        teamIds: principal.teams.map((t) => t.teamId),
      };
      const installations = (await router.listForPrincipal(ref)) as unknown as InstallationInfo[];
      const owners = [
        {
          ownerType: principal.type === 'user' ? ('user' as const) : ('service' as const),
          ownerId: principal.id,
        },
        ...ref.teamIds.map((teamId) => ({ ownerType: 'team' as const, ownerId: teamId })),
      ];
      const named: EndpointDefinition[] = [];
      for (const owner of owners) {
        for (const view of await endpoints.listForOwner(owner.ownerType, owner.ownerId)) {
          named.push(toEndpointDefinition(view) as EndpointDefinitionRow as EndpointDefinition);
        }
      }
      return { installations, namedEndpoints: named };
    },
    ready: refresh,
    watch() {
      const stop = watchConfig(infra, () => void refresh());
      const timer = setInterval(() => void refresh(), REFRESH_FALLBACK_MS);
      timer.unref();
      void refresh();
      return () => {
        stop();
        clearInterval(timer);
      };
    },
  };
};

/** `PrincipalProfilePort`: email and email domain for templates and Cedar (`principal.emailDomain`). */
export const createPrincipalProfiles = (infra: Infra): PrincipalProfilePort => {
  type Profile = { email?: string; emailDomain?: string };
  const cache = new TtlCache<string, Profile>({
    ttlMs: PROFILE_TTL_MS,
    max: MAX_PROFILES_CACHED,
    clock: infra.clock,
  });
  return {
    async profile(principal) {
      if (principal.type !== 'user') return {};
      const hit = cache.get(principal.id);
      if (hit) return hit;
      const user = await infra.repos.users.get(principal.id);
      const email = user?.email;
      const at = email ? email.lastIndexOf('@') : -1;
      const value: Profile = email
        ? { email, ...(at >= 0 ? { emailDomain: email.slice(at + 1).toLowerCase() } : {}) }
        : {};
      cache.set(principal.id, value);
      return value;
    },
  };
};

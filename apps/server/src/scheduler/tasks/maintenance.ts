import { MS } from '@bastion-mcp/core';
import type { TaskFn } from '../types';

/**
 * 9.6 daily sweep: refreshes every upstream token that would expire before the next run (plus margin), so users who
 * were away for a day find working credentials. Failures are counted, never thrown: the broker marks a token
 * `reconnect_required` itself when the refresh token is gone.
 */
export const upstreamTokenSweep: TaskFn = async ({ infra, deps, now }) => {
  if (!deps.refreshUpstreamToken) return { skipped: 'no refresh callback' };
  const before = new Date(now().getTime() + 26 * MS.HOUR);
  const rows = await infra.repos.upstreamTokens.listExpiringBefore(before);
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deps.refreshUpstreamToken(row.principalId, row.installationId);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      infra.logger.warn(
        {
          installationId: row.installationId,
          err: error instanceof Error ? error.message : 'error',
        },
        'upstream token refresh failed',
      );
    }
  }
  return { candidates: rows.length, refreshed, failed };
};

/** 13.6: installations whose definitions are pinned (directly or through their catalog version). */
export const pinnedInstallationIds = async (
  prisma: import('@bastion-mcp/db').PrismaClient,
): Promise<string[]> => {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT i.id::text AS id
    FROM installations i
    LEFT JOIN catalog_entries e ON e.id = i.catalog_entry_id
    JOIN definition_pins p
      ON p.installation_id = i.id
      OR p.catalog_version_id = COALESCE(i.catalog_version_id, e.current_version_id)
    WHERE i.enabled`;
  return rows.map((r) => r.id);
};

/** 13.6 pin re-verification: re-lists each pinned installation and applies the drift policy (daily). */
export const pinReverification: TaskFn = async ({ infra, deps }) => {
  if (!deps.reverifyPins) return { skipped: 'no reverify callback' };
  const ids = await pinnedInstallationIds(infra.db.prisma);
  let failed = 0;
  for (const id of ids) {
    try {
      await deps.reverifyPins(id);
    } catch (error) {
      failed += 1;
      infra.logger.warn(
        { installationId: id, err: error instanceof Error ? error.message : 'error' },
        'pin re-verification failed',
      );
    }
  }
  return { installations: ids.length, failed };
};

/** Expired `oidc_models` rows (authorization codes, interactions, sessions) are deleted hourly (9.3). */
export const cleanupExpired: TaskFn = async ({ infra, now }) => {
  const purged = await infra.repos.oidcModels.purgeExpired(now());
  return { oidcModels: purged };
};

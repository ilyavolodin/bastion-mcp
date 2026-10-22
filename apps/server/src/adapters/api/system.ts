/**
 * `SystemStatusPort` (17.2 `/system`): what the admin console's system page shows: replicas, leases, queues, the
 * sandbox driver, registry sync, KMS and the config version; plus the two operator actions, KEK rewrap and
 * signing-key rotation (22.3, 9.3).
 */
import {
  ConflictApiError,
  type SystemStatus,
  type SystemStatusPort,
  ValidationApiError,
} from '@bastion-mcp/api';
import { REDIS_CHANNELS, redisKeys } from '@bastion-mcp/core';
import { appendAuditEvent, Prisma } from '@bastion-mcp/db';
import {
  generateEs256KeyPair,
  ROTATION_POLICIES,
  retireAfterFor,
  rewrapAll,
  rotateKeyring,
} from '@bastion-mcp/secrets';
import { createBackup, RestoreRefusedError, readBackup, restoreBackup } from '../../backup/backup';
import { createMaintenance } from '../../backup/maintenance';
import { BackupFileError } from '../../backup/sealed-file';
import type { Infra } from '../../infra';

export type SystemStatusDeps = {
  /** The sandbox driver state of this worker (or `none` on a ui-only replica). */
  driverState: () => Promise<{ name: string; healthy: boolean; detail?: string }>;
};

const KMS_ROTATED_KEY = 'system:kms:lastRotatedAt';

/** Redis `SCAN` over one pattern, bounded so a huge keyspace cannot stall the page. */
const scan = async (redis: Infra['redis'], pattern: string, max = 5000): Promise<string[]> => {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < max);
  return keys;
};

/** Backup problems the operator can fix are reported as API errors, not as 500s. */
const asApiError = (error: unknown): unknown => {
  if (error instanceof BackupFileError) return new ValidationApiError(error.message);
  if (error instanceof RestoreRefusedError) {
    return error.code === 'invalid' || error.code === 'newer_schema'
      ? new ValidationApiError(error.message)
      : new ConflictApiError(error.message, { code: `restore_${error.code}` });
  }
  return error;
};

export const createSystemStatus = (infra: Infra, deps: SystemStatusDeps): SystemStatusPort => {
  const { redis, db, repos } = infra;
  const maintenance = createMaintenance(redis);

  const replicas = async (): Promise<SystemStatus['replicas']> => {
    const out: SystemStatus['replicas'] = [];
    for (const key of await scan(redis, 'workers:*')) {
      const h = await redis.hgetall(key);
      if (!h.address) continue;
      out.push({
        id: key.slice('workers:'.length),
        role: h.role ?? 'worker',
        startedAt: new Date(Number(h.startedAt ?? 0)).toISOString(),
        version: h.version ?? 'unknown',
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };

  const leases = async (): Promise<SystemStatus['leases']> => {
    const keys = await scan(redis, 'lease:*');
    const ids = keys.map((k) => k.slice('lease:'.length));
    const byInstallation: Record<string, number> = {};
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (valid.length > 0) {
      const rows = await db.prisma.instance.findMany({
        where: { id: { in: valid } },
        select: { installationId: true },
      });
      for (const r of rows) {
        if (r.installationId)
          byInstallation[r.installationId] = (byInstallation[r.installationId] ?? 0) + 1;
      }
    }
    return { active: ids.length, byInstallation };
  };

  /** Job queue depth per graphile-worker task, when the scheduler's schema exists (21). */
  const queues = async (): Promise<SystemStatus['queues']> => {
    try {
      const exists = await db.prisma.$queryRaw<{ t: string | null }[]>`
        SELECT to_regclass('graphile_worker.jobs')::text AS t`;
      if (!exists[0]?.t) return {};
      const rows = await db.prisma.$queryRaw<
        { task: string; depth: number; age: number | null }[]
      >(Prisma.sql`
        SELECT task_identifier AS task, count(*)::int AS depth,
               extract(epoch FROM (now() - min(run_at)))::float AS age
        FROM graphile_worker.jobs WHERE locked_at IS NULL AND run_at <= now()
        GROUP BY task_identifier`);
      return Object.fromEntries(
        rows.map((r) => [
          r.task,
          {
            depth: r.depth,
            ...(r.age === null ? {} : { oldestAgeSeconds: Math.max(0, Math.round(r.age)) }),
          },
        ]),
      );
    } catch {
      return {};
    }
  };

  const registrySync = async (): Promise<SystemStatus['registrySync']> =>
    (await repos.registrySources.list()).map((s) => ({
      sourceId: s.id,
      name: s.name,
      lastSyncAt: s.lastSync?.finishedAt ?? null,
      ok: s.lastSync ? s.lastSync.ok : null,
      ...(s.lastSync?.error ? { error: s.lastSync.error } : {}),
    }));

  const kmsStatus = async (): Promise<SystemStatus['kms']> => {
    const health = await infra.kms.health().catch((e: unknown) => ({
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    }));
    const rotated = await redis.get(KMS_ROTATED_KEY).catch(() => null);
    return {
      provider: infra.config.kms,
      healthy: health.ok,
      kekRef: health.ok ? infra.kms.kekRef : null,
      lastRotatedAt: rotated,
    };
  };

  const configVersion = async (): Promise<string> => {
    const rows = await repos.configVersions.list();
    return rows.reduce((sum, r) => sum + r.version, 0n).toString();
  };

  return {
    async status() {
      const [r, l, q, driver, sync, kms, cv] = await Promise.all([
        replicas(),
        leases(),
        queues(),
        deps.driverState().catch((e: unknown) => ({
          name: 'unknown',
          healthy: false,
          detail: e instanceof Error ? e.message : String(e),
        })),
        registrySync(),
        kmsStatus(),
        configVersion(),
      ]);
      return {
        replicas: r,
        leases: l,
        queues: q,
        driver,
        registrySync: sync,
        kms,
        configVersion: cv,
      };
    },

    /** Re-wraps every data key that is not under the current KEK; nothing else about the secrets changes (22.3). */
    async rotateKms() {
      const result = await rewrapAll(repos.secrets, infra.kms);
      if (result.failed.length > 0) {
        infra.logger.warn(
          { failed: result.failed.length },
          'some data keys could not be rewrapped',
        );
      }
      await redis.set(KMS_ROTATED_KEY, new Date().toISOString()).catch(() => undefined);
      return { kekRef: infra.kms.kekRef, rewrapped: result.rewrapped };
    },

    /** Adds a fresh signing key now (the old ones stay valid for the grace period) and tells workers to reload (9.3). */
    async rotateSigningKeys() {
      const store = repos.keyStore;
      if (!store) throw new Error('the key store is not configured');
      const pair = generateEs256KeyPair();
      const now = new Date();
      await store.addSigningKey(
        {
          kid: pair.kid,
          purpose: 'as',
          alg: 'ES256',
          publicJwk: pair.publicJwk,
          activeFrom: now,
          retireAfter: retireAfterFor(now, ROTATION_POLICIES.as),
        },
        pair.privateJwk,
      );
      // Housekeeping: drops keys past their grace period.
      await rotateKeyring(store, 'as');
      await infra.publish(REDIS_CHANNELS.config, JSON.stringify({ topic: 'signing_keys' }));
      return { kids: [pair.kid] };
    },

    async createBackup({ passphrase, actorId }) {
      try {
        const report = await createBackup(infra, passphrase, { id: actorId });
        const stamp = report.createdAt.toISOString().replaceAll(/[:.]/g, '-');
        return {
          filename: `bastion-backup-${stamp}.bastion-backup`,
          size: report.file.length,
          createdAt: report.createdAt.toISOString(),
          counts: report.counts,
          data: report.file.toString('base64'),
        };
      } catch (error) {
        throw asApiError(error);
      }
    },

    async restoreBackup({ data, passphrase, mode, dryRun, actorId }) {
      try {
        const { document } = await readBackup(Buffer.from(data, 'base64'), passphrase);
        return await restoreBackup(infra, maintenance, document, { mode, dryRun, actorId });
      } catch (error) {
        throw asApiError(error);
      }
    },

    maintenance: () => maintenance.get(),

    async setMaintenance({ enabled, actorId }) {
      const state = await maintenance.set(enabled, actorId);
      await infra.db.prisma.$transaction((tx) =>
        appendAuditEvent(tx, {
          actorType: 'user',
          actorId,
          action: enabled ? 'maintenance.enable' : 'maintenance.disable',
          targetType: 'system',
          targetId: 'maintenance',
        }),
      );
      return state;
    },
  };
};

export { redisKeys };

/**
 * `/healthz` (liveness) and `/readyz` (readiness, per-check JSON) of 15.1 / 21. Readiness runs the checks of the
 * telemetry `HealthRegistry`: Postgres, Redis, migrations current and, on workers, the sandbox driver state and the
 * internal RPC listener.
 */
import { HealthRegistry } from '@bastion-mcp/telemetry';
import type { FastifyInstance } from 'fastify';
import { bundledMigrations } from '../boot/migrate';
import type { DriverState } from '../contracts';
import type { Infra } from '../infra';

export type HealthDeps = {
  infra: Infra;
  /** Worker role only. */
  worker?: { driverState(): Promise<DriverState>; internalRpcListening(): boolean } | undefined;
  /** Extra checks (scheduler state, tests). */
  extra?: Record<string, () => Promise<{ ok: boolean; detail?: unknown }>>;
};

export const createHealthRegistry = ({ infra, worker, extra }: HealthDeps): HealthRegistry => {
  const registry = new HealthRegistry({ timeoutMs: 2000 });
  registry.register('postgres', async () => {
    await infra.db.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
  registry.register('redis', async () => {
    const reply = await infra.redis.ping();
    return { ok: reply === 'PONG' };
  });
  registry.register('migrations', async () => {
    const rows = await infra.db.prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const done = new Set(rows.map((r) => r.migration_name));
    const pending = bundledMigrations()
      .map((m) => m.name)
      .filter((n) => !done.has(n));
    return {
      ok: pending.length === 0,
      detail: pending.length === 0 ? { applied: done.size } : { pending },
    };
  });
  if (worker) {
    // The driver check is informational for bubblewrap (remote upstreams keep working without a sandbox) and
    // blocking for the Kubernetes driver, where an unreachable cluster means package servers cannot start.
    registry.register('sandbox', async () => {
      const state = await worker.driverState();
      return {
        ok: state.healthy || state.name !== 'kubernetes',
        detail: {
          driver: state.name,
          healthy: state.healthy,
          ...(state.detail ? { reason: state.detail } : {}),
        },
      };
    });
    registry.register('internal-rpc', async () => ({ ok: worker.internalRpcListening() }));
  }
  for (const [name, check] of Object.entries(extra ?? {})) registry.register(name, check);
  return registry;
};

export const registerHealthRoutes = (app: FastifyInstance, registry: HealthRegistry): void => {
  app.get('/healthz', { logLevel: 'silent' }, async () => registry.liveness());
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    const report = await registry.run();
    return reply.code(report.ok ? 200 : 503).send(report);
  });
};

import { redisKeys } from '@bastion-mcp/core';
import type { GcDecision, GcKnownState, SandboxDriver } from '@bastion-mcp/sandbox';
import type { Infra } from '../../infra';
import type { TaskFn } from '../types';

type GcCapable = SandboxDriver & { collectGarbage(known: GcKnownState): Promise<GcDecision[]> };

const canCollect = (driver: SandboxDriver): driver is GcCapable =>
  typeof (driver as Partial<GcCapable>).collectGarbage === 'function';

/**
 * What Postgres and Redis say is alive (8.4): instance id to the time its lease expired (null while a lease is live),
 * and every installation id (persistent claims are keyed by installation).
 */
export const knownSandboxState = async (infra: Infra, now: Date): Promise<GcKnownState> => {
  const prisma = infra.db.prisma;
  const instances = await prisma.instance.findMany({
    select: { id: true, lastUsedAt: true, updatedAt: true, createdAt: true },
  });
  const map = new Map<string, { leaseExpiredAt: number | null }>();
  for (const instance of instances) {
    const lease = await infra.redis.exists(redisKeys.lease(instance.id));
    const last = instance.lastUsedAt ?? instance.updatedAt ?? instance.createdAt;
    map.set(instance.id, {
      leaseExpiredAt: lease === 1 ? null : Math.min(last.getTime(), now.getTime()),
    });
  }
  const installations = new Set(
    (await prisma.installation.findMany({ select: { id: true } })).map((i) => i.id),
  );
  return { instances: map, installations };
};

/**
 * 8.4 garbage collection every 5 minutes. The Kubernetes driver deletes claims and sandboxes whose instance is
 * unknown or whose lease expired more than 10 minutes ago (`collectGarbage` + `selectClaimsToDelete`). Drivers
 * without that method (bubblewrap) are swept through `list()`: a sandbox no instance row refers to is destroyed.
 */
export const sandboxGarbageCollection: TaskFn = async ({ infra, deps, now }) => {
  const driver = deps.driver;
  if (!driver) return { skipped: 'no driver' };
  const at = now();
  if (canCollect(driver)) {
    const decisions = await driver.collectGarbage(await knownSandboxState(infra, at));
    return { driver: 'kubernetes', deleted: decisions.filter((d) => d.delete).map((d) => d.name) };
  }
  const refs = await infra.db.prisma.instance.findMany({ select: { sandboxRef: true } });
  const known = new Set<string>();
  for (const row of refs) {
    const id = (row.sandboxRef as { id?: unknown } | null)?.id;
    if (typeof id === 'string') known.add(id);
  }
  const deleted: string[] = [];
  for await (const ref of driver.list()) {
    if (known.has(ref.id)) continue;
    await driver.destroy(ref);
    deleted.push(ref.id);
  }
  return { driver: 'list', deleted };
};

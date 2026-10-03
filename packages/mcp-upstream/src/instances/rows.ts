import { newId } from '@bastion-mcp/core';
import type { InstanceRecord, ResolvedInstallation } from '../ports';

/** A shared pool never grows beyond this many replicas, whatever the catalog asks for (8.6). */
export const MAX_SHARED_REPLICAS = 10;

/** Whether the installation runs in the catalog version's shared pool rather than in a per-user instance (8.6). */
export const isSharedPackage = (installation: ResolvedInstallation): boolean =>
  installation.spec.type === 'package' && installation.spec.instanceScope === 'shared';

/**
 * Picks the pool member to use: the replica with the fewest in-flight calls, unless it is busy and the pool may still
 * grow, in which case `undefined` asks the caller for a new replica (8.6). Pure.
 */
export const pickSharedReplica = <R>(
  rows: ReadonlyArray<{ row: R; load: number }>,
  wantedReplicas: number,
): R | undefined => {
  const best = [...rows].sort((a, b) => a.load - b.load)[0];
  const maxReplicas = Math.min(MAX_SHARED_REPLICAS, Math.max(1, wantedReplicas));
  return best && (best.load === 0 || rows.length >= maxReplicas) ? best.row : undefined;
};

/** A fresh, never-started row for an installation (or for the next replica of its shared pool). */
export const newInstanceRecord = (
  installation: ResolvedInstallation,
  kind: InstanceRecord['kind'],
  replica: number,
  now: number,
): InstanceRecord => {
  const shared = isSharedPackage(installation);
  return {
    id: newId(),
    installationId: shared ? null : installation.installationId,
    catalogVersionId: installation.catalogVersionId,
    userId: shared ? null : installation.ownerUserId,
    kind,
    replica,
    lastUsedAt: now,
    failures: [],
  };
};

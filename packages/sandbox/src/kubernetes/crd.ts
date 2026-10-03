import { MS, type SandboxSize, sha256Hex } from '@bastion-mcp/core';
import { z } from 'zod';
import type { SandboxSpec } from '../types';

/**
 * Pure builders and parsers for the agent-sandbox v1beta1 objects (8.4, docs/spikes/m3-agent-sandbox.md).
 * Nothing here touches the cluster.
 */

export const SANDBOX_API = {
  group: 'agents.x-k8s.io',
  version: 'v1beta1',
  plural: 'sandboxes',
} as const;
export const CLAIM_API = {
  group: 'extensions.agents.x-k8s.io',
  version: 'v1beta1',
  plural: 'sandboxclaims',
} as const;

export const LABELS = {
  instance: 'bastion-mcp.github.io/instance',
  installation: 'bastion-mcp.github.io/installation',
  userHash: 'bastion-mcp.github.io/user-hash',
  persistent: 'bastion-mcp.github.io/persistent',
} as const;

export const RUNNER_PORT = 8080;
export const SHUTDOWN_AFTER_MS = MS.DAY;
export const SHUTDOWN_REFRESH_INTERVAL_MS = MS.HOUR;

const hex = (id: string): string => id.replace(/-/g, '').toLowerCase();

const assertHexId = (id: string): string => {
  const h = hex(id);
  if (!/^[0-9a-f]{12,}$/.test(h)) throw new TypeError(`invalid id "${id}"`);
  return h;
};

/** `bst-<last 12 hex of instanceId>`: the random tail of a UUIDv7 (the head is a timestamp; see ADR 0001) (8.4). */
export const instanceClaimName = (instanceId: string): string =>
  `bst-${assertHexId(instanceId).slice(-12)}`;

/** `bsp-<last 12 hex of installationId>` (8.4). */
export const persistentClaimName = (installationId: string): string =>
  `bsp-${assertHexId(installationId).slice(-12)}`;

export const isPersistentClaimName = (name: string): boolean => name.startsWith('bsp-');

/** SHA-256 of the user id, first 16 hex characters (label value, 8.4). */
export const userHash = (userId: string): string => sha256Hex(userId).slice(0, 16);

/** Warm pool of a size; persistent workspaces use the `-pvc` pool with `replicas: 0` (8.4). */
export const warmPoolName = (size: SandboxSize, persistent: boolean): string =>
  `bastion-runtime-${size}${persistent ? '-pvc' : ''}`;

export const shutdownTimeFrom = (nowMs: number): string =>
  new Date(nowMs + SHUTDOWN_AFTER_MS).toISOString();

export const needsShutdownRefresh = (lastRefreshMs: number, nowMs: number): boolean =>
  nowMs - lastRefreshMs >= SHUTDOWN_REFRESH_INTERVAL_MS;

export type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    resourceVersion?: string;
    uid?: string;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
};

export const kubeObjectSchema = z
  .object({
    apiVersion: z.string().optional(),
    kind: z.string().optional(),
    metadata: z
      .object({
        name: z.string(),
        namespace: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
        creationTimestamp: z.string().optional(),
        resourceVersion: z.string().optional(),
        uid: z.string().optional(),
      })
      .passthrough(),
    spec: z.record(z.string(), z.unknown()).optional(),
    status: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const claimStatusSchema = z.object({
  conditions: z
    .array(
      z.object({
        type: z.string(),
        status: z.string(),
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
  sandbox: z
    .object({
      name: z.string().optional(),
      podIPs: z.array(z.string()).optional(),
      serviceFQDN: z.string().optional(),
    })
    .optional(),
});
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const parseClaimStatus = (claim: KubeObject): ClaimStatus => {
  const parsed = claimStatusSchema.safeParse(claim.status ?? {});
  return parsed.success ? parsed.data : {};
};

/** `host:8080` once `status.sandbox.podIPs` or `serviceFQDN` is set (8.4); null while pending. */
export const runnerAddressOf = (claim: KubeObject): string | null => {
  const sandbox = parseClaimStatus(claim).sandbox;
  const ip = sandbox?.podIPs?.[0];
  if (ip) return `${ip.includes(':') ? `[${ip}]` : ip}:${RUNNER_PORT}`;
  if (sandbox?.serviceFQDN) return `${sandbox.serviceFQDN}:${RUNNER_PORT}`;
  return null;
};

export const boundSandboxName = (claim: KubeObject): string | null =>
  parseClaimStatus(claim).sandbox?.name ?? null;

export const claimReadyCondition = (
  claim: KubeObject,
): ClaimStatus['conditions'] extends (infer C)[] | undefined ? C | null : never =>
  parseClaimStatus(claim).conditions?.find((c) => c.type === 'Ready') ?? null;

export type ClaimInput = {
  spec: SandboxSpec;
  namespace: string;
  nowMs: number;
  poolName?: string;
  storageClassName?: string;
};

/** The `SandboxClaim` the worker creates at start (8.4). */
export const buildClaim = (input: ClaimInput): KubeObject => {
  const { spec } = input;
  const persistent = spec.workspace.persistent;
  if (persistent && !spec.installationId) {
    throw new TypeError('persistent workspaces need an installation id');
  }
  const name = persistent
    ? persistentClaimName(spec.installationId as string)
    : instanceClaimName(spec.instanceId);
  const labels: Record<string, string> = {
    [LABELS.instance]: spec.instanceId,
    ...(spec.installationId ? { [LABELS.installation]: spec.installationId } : {}),
    ...(spec.userId ? { [LABELS.userHash]: userHash(spec.userId) } : {}),
    ...(persistent ? { [LABELS.persistent]: 'true' } : {}),
  };
  const claimSpec: Record<string, unknown> = {
    warmPoolRef: { name: input.poolName ?? warmPoolName(spec.size, persistent) },
  };
  if (persistent) {
    // No shutdownTime: the workspace outlives idle periods (suspend/resume) until the installation is deleted.
    claimSpec.volumeClaimTemplates = [
      {
        metadata: { name: 'workspace', labels },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: `${spec.workspace.sizeMiB}Mi` } },
          ...(input.storageClassName ? { storageClassName: input.storageClassName } : {}),
        },
      },
    ];
  } else {
    claimSpec.lifecycle = { shutdownPolicy: 'Delete', shutdownTime: shutdownTimeFrom(input.nowMs) };
  }
  return {
    apiVersion: `${CLAIM_API.group}/${CLAIM_API.version}`,
    kind: 'SandboxClaim',
    metadata: { name, namespace: input.namespace, labels },
    spec: claimSpec,
  };
};

/** Merge patch that extends the shutdown time while the instance is in use (hourly, 8.4). */
export const refreshShutdownPatch = (nowMs: number): Record<string, unknown> => ({
  spec: { lifecycle: { shutdownPolicy: 'Delete', shutdownTime: shutdownTimeFrom(nowMs) } },
});

export const operatingModePatch = (mode: 'Running' | 'Suspended'): Record<string, unknown> => ({
  spec: { operatingMode: mode },
});

/** Label selector for everything Bastion created. */
export const bastionSelector = `${LABELS.instance}`;
export const installationSelector = (installationId: string): string =>
  `${LABELS.installation}=${installationId}`;

// --- garbage collection (8.4) --------------------------------------------------------------------------------------
export const GC_LEASE_GRACE_MS = 10 * MS.MINUTE;

export type GcKnownState = {
  /** instance id -> epoch ms at which its lease expired; null while a lease is live or never expired. */
  instances: ReadonlyMap<string, { leaseExpiredAt: number | null }>;
  /** Installation ids that still exist in Postgres (persistent claims are keyed by installation). */
  installations: ReadonlySet<string>;
};

export type GcDecision = {
  name: string;
  delete: boolean;
  reason: 'unknown-instance' | 'unknown-installation' | 'lease-expired' | 'keep';
};

/**
 * Pure garbage-collection policy (8.4): delete claims whose instance is not in Postgres or whose lease
 * expired more than 10 minutes ago. Persistent claims are judged by their installation instead, because
 * they have no live instance while suspended.
 */
export const decideClaimGc = (
  claim: KubeObject,
  known: GcKnownState,
  nowMs: number,
): GcDecision => {
  const labels = claim.metadata.labels ?? {};
  const name = claim.metadata.name;
  if (labels[LABELS.persistent] === 'true') {
    const installation = labels[LABELS.installation];
    return installation && known.installations.has(installation)
      ? { name, delete: false, reason: 'keep' }
      : { name, delete: true, reason: 'unknown-installation' };
  }
  const instanceId = labels[LABELS.instance];
  const instance = instanceId ? known.instances.get(instanceId) : undefined;
  if (!instance) return { name, delete: true, reason: 'unknown-instance' };
  if (instance.leaseExpiredAt !== null && nowMs - instance.leaseExpiredAt > GC_LEASE_GRACE_MS) {
    return { name, delete: true, reason: 'lease-expired' };
  }
  return { name, delete: false, reason: 'keep' };
};

export const selectClaimsToDelete = (
  claims: readonly KubeObject[],
  known: GcKnownState,
  nowMs: number,
): GcDecision[] => claims.map((c) => decideClaimGc(c, known, nowMs)).filter((d) => d.delete);

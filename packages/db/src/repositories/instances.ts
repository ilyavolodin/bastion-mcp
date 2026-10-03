import { canonicalJson, INSTANCE_KINDS, newId, REVIEW_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { EgressAccessRequest, Instance } from '../generated/client';
import {
  type AuditContext,
  afterKey,
  bytesToHex,
  ConflictError,
  compact,
  hexToBytes,
  idCursorOf,
  mutate,
  NotFoundError,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  toContext,
  toJson,
  toJsonOrNull,
} from './support';

// --- instances (8.6) -----------------------------------------------------------------------------------------------------

export type InstanceKind = (typeof INSTANCE_KINDS)[number];

const remoteSessionSchema = z.object({
  sessionId: z.string(),
  protocolVersion: z.string(),
  url: z.string(),
  serverCapabilities: z.record(z.string(), z.unknown()).optional(),
});
const sandboxRefSchema = z.object({ id: z.string(), address: z.string() });
const lastErrorSchema = z.object({
  phase: z.string(),
  message: z.string(),
  stderrTail: z.array(z.string()),
  at: z.number(),
});
const failuresSchema = z.array(z.number());

/** `InstanceRecord` of `@bastion-mcp/mcp-upstream` (`ports.ts`). */
export type InstanceRecord = {
  id: string;
  installationId: string | null;
  catalogVersionId: string;
  userId: string | null;
  kind: InstanceKind;
  replica: number;
  sandbox?: { driver: 'kubernetes' | 'bubblewrap'; id: string; address: string } | undefined;
  remoteSession?: z.infer<typeof remoteSessionSchema> | undefined;
  startedAt?: number | undefined;
  lastUsedAt: number;
  failures: number[];
  error?: z.infer<typeof lastErrorSchema> | undefined;
  runningVersionId?: string | undefined;
};

/** The `instances.state` values: `failed` while an error is recorded, `running` once started (8.6). */
export const instanceState = (r: Pick<InstanceRecord, 'startedAt' | 'error'>): string =>
  r.error ? 'failed' : r.startedAt === undefined ? 'starting' : 'running';

const kindSchema = z.enum(INSTANCE_KINDS);
const driverSchema = z.enum(['kubernetes', 'bubblewrap']);

const toInstance = (row: Instance): InstanceRecord => {
  const sandboxRef = row.sandboxRef === null ? undefined : sandboxRefSchema.parse(row.sandboxRef);
  return {
    id: row.id,
    installationId: row.installationId,
    catalogVersionId: row.catalogVersionId ?? '',
    userId: row.userId,
    kind: kindSchema.parse(row.kind),
    replica: row.replica,
    ...(row.driver && sandboxRef
      ? { sandbox: { driver: driverSchema.parse(row.driver), ...sandboxRef } }
      : {}),
    ...(row.remoteSession === null
      ? {}
      : { remoteSession: remoteSessionSchema.parse(row.remoteSession) }),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    lastUsedAt: (row.lastUsedAt ?? row.createdAt).getTime(),
    failures: failuresSchema.parse(row.failures),
    ...(row.lastError === null ? {} : { error: lastErrorSchema.parse(row.lastError) }),
    ...(row.runningVersionId ? { runningVersionId: row.runningVersionId } : {}),
  };
};

/** `InstanceRepository` over `instances`; `claimIdle` is the reaper's `FOR UPDATE SKIP LOCKED` claim. */
export const createInstanceRepository = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(instanceId: string): Promise<InstanceRecord | null> {
      const row = await db.instance.findUnique({ where: { id: instanceId } });
      return row ? toInstance(row) : null;
    },
    async getForInstallation(installationId: string): Promise<InstanceRecord | null> {
      const row = await db.instance.findFirst({
        where: { installationId },
        orderBy: [{ replica: 'asc' }, { id: 'desc' }],
      });
      return row ? toInstance(row) : null;
    },
    /** Shared pool members of a catalog version (`installation_id` null), by replica. */
    async listShared(catalogVersionId: string): Promise<InstanceRecord[]> {
      const rows = await db.instance.findMany({
        where: { installationId: null, catalogVersionId },
        orderBy: { replica: 'asc' },
      });
      return rows.map(toInstance);
    },
    /**
     * Upsert by id. A different row already holding the same `(installation, replica)` (or shared
     * `(version, replica)`) slot is replaced: the unique indexes allow one live instance per slot.
     */
    save(record: InstanceRecord): Promise<void> {
      return mutate(ctx, async (tx) => {
        await tx.instance.deleteMany({
          where: {
            id: { not: record.id },
            replica: record.replica,
            ...(record.installationId
              ? { installationId: record.installationId }
              : { installationId: null, catalogVersionId: record.catalogVersionId }),
          },
        });
        const data = {
          installationId: record.installationId,
          replica: record.replica,
          kind: record.kind,
          driver: record.sandbox?.driver ?? null,
          sandboxRef: toJsonOrNull(
            record.sandbox ? { id: record.sandbox.id, address: record.sandbox.address } : null,
          ),
          catalogVersionId: record.catalogVersionId === '' ? null : record.catalogVersionId,
          state: instanceState(record),
          startedAt: record.startedAt === undefined ? null : new Date(record.startedAt),
          lastUsedAt: new Date(record.lastUsedAt),
          failureCount: record.failures.length,
          failures: toJson(record.failures),
          lastError: toJsonOrNull(record.error),
          userId: record.userId,
          remoteSession: toJsonOrNull(record.remoteSession),
          runningVersionId: record.runningVersionId ?? null,
        };
        await tx.instance.upsert({
          where: { id: record.id },
          create: { id: record.id, ...data },
          update: { ...data, updatedAt: new Date() },
        });
      });
    },
    /** Sandboxes that are starting or running, optionally for one user (per-user limit, 8.6). */
    async listRunning(userId?: string): Promise<InstanceRecord[]> {
      const rows = await db.instance.findMany({
        where: {
          kind: 'sandbox',
          state: { in: ['starting', 'running'] },
          ...(userId ? { userId } : {}),
        },
        orderBy: { id: 'asc' },
      });
      return rows.map(toInstance);
    },
    async delete(instanceId: string): Promise<void> {
      await db.instance.deleteMany({ where: { id: instanceId } });
    },

    /**
     * Claims up to `limit` running instances idle since before `idleBefore` for shutdown by marking them
     * `stopping`. `FOR UPDATE SKIP LOCKED` lets several reapers run without claiming the same row twice.
     */
    async claimIdle(idleBefore: Date, limit: number): Promise<string[]> {
      const rows = await db.$queryRaw<{ id: string }[]>`
        UPDATE instances SET state = 'stopping', updated_at = now()
        WHERE id IN (
          SELECT id FROM instances
          WHERE state = 'running' AND last_used_at < ${idleBefore}
          ORDER BY last_used_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id`;
      return rows.map((r) => r.id);
    },
  };
};

// --- upstream_snapshots (7.5) ------------------------------------------------------------------------------------------------

/** `SnapshotItems` of `@bastion-mcp/mcp-upstream`. */
export type SnapshotItems = {
  tools: unknown[];
  prompts: unknown[];
  resources: unknown[];
  resourceTemplates: unknown[];
  instructions?: string | undefined;
  serverInfo?: { name: string; version: string; title?: string } | undefined;
  ttlMs?: number | undefined;
};

const arraySchema = z.array(z.unknown());
const serverInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  title: z.string().optional(),
});

/** Snapshots kept per `(installation, configHash)` key; older ones are pruned on write. */
export const SNAPSHOTS_KEPT = 3;

const toItems = (row: {
  tools: unknown;
  prompts: unknown;
  resources: unknown;
  resourceTemplates: unknown;
  instructions: string | null;
  serverInfo: unknown;
  ttlMs: number | null;
}): SnapshotItems => ({
  tools: arraySchema.parse(row.tools),
  prompts: arraySchema.parse(row.prompts),
  resources: arraySchema.parse(row.resources),
  resourceTemplates: arraySchema.parse(row.resourceTemplates),
  ...(row.instructions === null ? {} : { instructions: row.instructions }),
  ...(row.serverInfo === null
    ? {}
    : {
        serverInfo: compact<NonNullable<SnapshotItems['serverInfo']>>(
          serverInfoSchema.parse(row.serverInfo),
        ),
      }),
  ...(row.ttlMs === null ? {} : { ttlMs: row.ttlMs }),
});

const sameContent = (a: SnapshotItems, b: SnapshotItems): boolean =>
  canonicalJson({ ...a, ttlMs: undefined }) === canonicalJson({ ...b, ttlMs: undefined });

/**
 * `SnapshotStore` keyed by `(installationId, configHash)` (7.5) plus the catalog reference snapshot (11.3).
 * `configHash` is lowercase hex (`bytea` in the table). An identical re-capture only refreshes `captured_at`.
 */
export const createSnapshotStore = (arg: PrismaLike | RepoContext, options?: RepoOptions) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  const store = (
    owner: { installationId: string | null; catalogVersionId: string | null },
    configHash: string,
    items: SnapshotItems,
  ): Promise<string> =>
    mutate(ctx, async (tx) => {
      const hash = hexToBytes(configHash);
      const latest = await tx.upstreamSnapshot.findFirst({
        where: { ...owner, configHash: hash },
        orderBy: { capturedAt: 'desc' },
      });
      if (latest && sameContent(toItems(latest), items)) {
        await tx.upstreamSnapshot.update({
          where: { id: latest.id },
          data: { capturedAt: new Date(), ttlMs: items.ttlMs ?? null },
        });
        return latest.id;
      }
      const row = await tx.upstreamSnapshot.create({
        data: {
          id: newId(),
          ...owner,
          configHash: hash,
          tools: toJson(items.tools),
          prompts: toJson(items.prompts),
          resources: toJson(items.resources),
          resourceTemplates: toJson(items.resourceTemplates),
          serverInfo: toJsonOrNull(items.serverInfo),
          instructions: items.instructions ?? null,
          ttlMs: items.ttlMs ?? null,
        },
      });
      const stale = await tx.upstreamSnapshot.findMany({
        where: { ...owner, configHash: hash },
        orderBy: { capturedAt: 'desc' },
        skip: SNAPSHOTS_KEPT,
        select: { id: true },
      });
      if (stale.length > 0) {
        await tx.upstreamSnapshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
      return row.id;
    });

  return {
    async get(installationId: string, configHash: string): Promise<SnapshotItems | null> {
      const row = await db.upstreamSnapshot.findFirst({
        where: { installationId, configHash: hexToBytes(configHash) },
        orderBy: { capturedAt: 'desc' },
      });
      return row ? toItems(row) : null;
    },
    /** The reference snapshot of the catalog version for the same config hash. */
    async getReference(
      catalogVersionId: string,
      configHash: string,
    ): Promise<SnapshotItems | null> {
      const row = await db.upstreamSnapshot.findFirst({
        where: { catalogVersionId, installationId: null, configHash: hexToBytes(configHash) },
        orderBy: { capturedAt: 'desc' },
      });
      return row ? toItems(row) : null;
    },
    put(installationId: string, configHash: string, items: SnapshotItems): Promise<void> {
      return store({ installationId, catalogVersionId: null }, configHash, items).then(
        () => undefined,
      );
    },
    /** Stores a catalog reference snapshot and returns its id for `catalog_versions.reference_snapshot_id`. */
    putReference(
      catalogVersionId: string,
      configHash: string,
      items: SnapshotItems,
    ): Promise<string> {
      return store({ installationId: null, catalogVersionId }, configHash, items);
    },
    async getById(id: string): Promise<SnapshotItems | null> {
      const row = await db.upstreamSnapshot.findUnique({ where: { id } });
      return row ? toItems(row) : null;
    },
    async hashOf(id: string): Promise<string | null> {
      const row = await db.upstreamSnapshot.findUnique({
        where: { id },
        select: { configHash: true },
      });
      return row ? bytesToHex(row.configHash) : null;
    },
  };
};

// --- egress_access_requests (8.8) ----------------------------------------------------------------------------------------------

export type EgressAccessRequestView = {
  id: string;
  installationId: string;
  host: string;
  port: number;
  requesterId: string;
  status: (typeof REVIEW_STATUSES)[number];
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

const statusSchema = z.enum(REVIEW_STATUSES);

const toEgressRequest = (r: EgressAccessRequest): EgressAccessRequestView => ({
  id: r.id,
  installationId: r.installationId,
  host: r.host,
  port: r.port,
  requesterId: r.requesterId,
  status: statusSchema.parse(r.status),
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

/** Requests from users for an extra egress host; an admin approves or rejects once (8.8). */
export const createEgressAccessRequestRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<EgressAccessRequestView | null> {
      const row = await db.egressAccessRequest.findUnique({ where: { id } });
      return row ? toEgressRequest(row) : null;
    },
    async list(
      filter: {
        installationId?: string;
        requesterId?: string;
        status?: EgressAccessRequestView['status'];
        limit?: number;
        cursor?: string;
      } = {},
    ): Promise<Paged<EgressAccessRequestView>> {
      return paginate(
        filter,
        (take) =>
          db.egressAccessRequest.findMany({
            where: {
              ...(filter.installationId ? { installationId: filter.installationId } : {}),
              ...(filter.requesterId ? { requesterId: filter.requesterId } : {}),
              ...(filter.status ? { status: filter.status } : {}),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toEgressRequest,
      );
    },
    /** One open request per `(installation, host, port, requester)`; a repeat returns the existing one. */
    create(
      input: {
        id?: string;
        installationId: string;
        host: string;
        port: number;
        requesterId: string;
      },
      audit?: AuditContext,
    ): Promise<{ request: EgressAccessRequestView; created: boolean }> {
      return mutate(ctx, async (tx, unit) => {
        const open = await tx.egressAccessRequest.findFirst({
          where: {
            installationId: input.installationId,
            host: input.host,
            port: input.port,
            requesterId: input.requesterId,
            status: 'open',
          },
        });
        if (open) return { request: toEgressRequest(open), created: false };
        const row = await tx.egressAccessRequest.create({
          data: {
            id: input.id ?? newId(),
            installationId: input.installationId,
            host: input.host,
            port: input.port,
            requesterId: input.requesterId,
          },
        });
        unit.audit(audit, {
          action: 'egress_request.create',
          targetType: 'egress_access_request',
          targetId: row.id,
          diff: { before: null, after: { host: row.host, port: row.port } },
        });
        return { request: toEgressRequest(row), created: true };
      });
    },
    decide(
      id: string,
      decision: { status: 'approved' | 'rejected'; decidedBy: string },
      audit?: AuditContext,
    ): Promise<EgressAccessRequestView> {
      return mutate(ctx, async (tx, unit) => {
        const res = await tx.egressAccessRequest.updateMany({
          where: { id, status: 'open' },
          data: { status: decision.status, decidedBy: decision.decidedBy, decidedAt: new Date() },
        });
        if (res.count === 0) {
          if ((await tx.egressAccessRequest.count({ where: { id } })) === 0)
            throw new NotFoundError('egress access request', id);
          throw new ConflictError('request was already decided', { id });
        }
        const row = await tx.egressAccessRequest.findUniqueOrThrow({ where: { id } });
        unit.bump('installation', row.installationId);
        unit.audit(audit, {
          action: `egress_request.${decision.status}`,
          targetType: 'egress_access_request',
          targetId: id,
          diff: {
            before: { status: 'open' },
            after: { status: decision.status, host: row.host, port: row.port },
          },
        });
        return toEgressRequest(row);
      });
    },
  };
};

import { ITEM_KINDS, newId, REVIEW_STATUSES } from '@bastion-mcp/core';
import { z } from 'zod';
import type { DefinitionPin, DriftReview } from '../generated/client';
import {
  type AuditContext,
  afterKey,
  bytesToHex,
  ConflictError,
  hexToBytes,
  idCursorOf,
  jsonObjectSchema,
  mutate,
  NotFoundError,
  type Paged,
  type PrismaLike,
  paginate,
  type RepoContext,
  type RepoOptions,
  type Tx,
  toContext,
  toJson,
} from './support';

// --- definition_pins and drift_reviews (13.6) ----------------------------------------------------------------------------------------

const itemKindSchema = z.enum(ITEM_KINDS);

/** A pin set belongs to a catalog version or, for personal installations, to the installation (13.6). */
export type PinSubject = { catalogVersionId: string } | { installationId: string };

export type PinInput = {
  itemKind: (typeof ITEM_KINDS)[number];
  itemKey: string;
  /** Lowercase hex SHA-256 (`pinDefinition`). */
  hash: string;
  definition: Record<string, unknown>;
  approvedBy?: string | null;
};

export type PinView = PinInput & { id: string; approvedAt: Date | null; createdAt: Date };

/** Insert-or-update of one pin by `(subject, kind, key)` on the unique expression index. */
export const upsertPinSql = (
  tx: Tx,
  pin: {
    catalogVersionId: string | null;
    installationId: string | null;
    itemKind: string;
    itemKey: string;
    hash: Uint8Array;
    definition: unknown;
    approvedBy: string | null;
  },
  now: Date = new Date(),
): Promise<number> =>
  tx.$executeRaw`
    INSERT INTO definition_pins
      (id, catalog_version_id, installation_id, item_kind, item_key, hash, definition, approved_by, approved_at)
    VALUES
      (${newId()}::uuid, ${pin.catalogVersionId}::uuid, ${pin.installationId}::uuid, ${pin.itemKind},
       ${pin.itemKey}, ${pin.hash}, ${JSON.stringify(pin.definition)}::jsonb,
       ${pin.approvedBy}::uuid, ${pin.approvedBy ? now : null})
    ON CONFLICT ((COALESCE(catalog_version_id, installation_id)), item_kind, item_key) DO UPDATE SET
      hash = EXCLUDED.hash, definition = EXCLUDED.definition,
      approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`;

const subjectColumns = (s: PinSubject) =>
  'catalogVersionId' in s
    ? { catalogVersionId: s.catalogVersionId, installationId: null }
    : { catalogVersionId: null, installationId: s.installationId };

const toPin = (r: DefinitionPin): PinView => ({
  id: r.id,
  itemKind: itemKindSchema.parse(r.itemKind),
  itemKey: r.itemKey,
  hash: bytesToHex(r.hash),
  definition: jsonObjectSchema.parse(r.definition),
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  createdAt: r.createdAt,
});

/** `definition_pins`: the pinned hash of every tool, prompt, resource and template of a subject. */
export const createDefinitionPinRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async list(subject: PinSubject): Promise<PinView[]> {
      const rows = await db.definitionPin.findMany({
        where: {
          catalogVersionId: subjectColumns(subject).catalogVersionId,
          installationId: subjectColumns(subject).installationId,
        },
        orderBy: [{ itemKind: 'asc' }, { itemKey: 'asc' }],
      });
      return rows.map(toPin);
    },

    /** `PinSet` of `@bastion-mcp/guards`: `{ "<kind>:<key>": hexHash }`; null when nothing is pinned (first use). */
    async pinSet(subject: PinSubject): Promise<Record<string, string> | null> {
      const pins = await this.list(subject);
      if (pins.length === 0) return null;
      return Object.fromEntries(pins.map((p) => [`${p.itemKind}:${p.itemKey}`, p.hash]));
    },

    /** Inserts or updates pins by `(subject, kind, key)`; idempotent on the unique expression index. */
    upsertPins(
      subject: PinSubject,
      pins: readonly PinInput[],
      audit?: AuditContext,
    ): Promise<void> {
      return mutate(ctx, async (tx, unit) => {
        const cols = subjectColumns(subject);
        for (const pin of pins) {
          itemKindSchema.parse(pin.itemKind);
          await upsertPinSql(tx, {
            catalogVersionId: cols.catalogVersionId,
            installationId: cols.installationId,
            itemKind: pin.itemKind,
            itemKey: pin.itemKey,
            hash: hexToBytes(pin.hash),
            definition: pin.definition,
            approvedBy: pin.approvedBy ?? null,
          });
        }
        if (pins.length > 0) {
          unit.audit(audit, {
            action: 'definition_pin.upsert',
            targetType: 'catalogVersionId' in subject ? 'catalog_version' : 'installation',
            targetId:
              'catalogVersionId' in subject ? subject.catalogVersionId : subject.installationId,
            diff: { before: null, after: { items: pins.map((p) => `${p.itemKind}:${p.itemKey}`) } },
          });
        }
      });
    },

    /** Drops pins whose item vanished upstream and was approved as removed. */
    async remove(
      subject: PinSubject,
      itemKind: PinInput['itemKind'],
      itemKey: string,
    ): Promise<boolean> {
      const cols = subjectColumns(subject);
      const res = await db.definitionPin.deleteMany({
        where: {
          catalogVersionId: cols.catalogVersionId,
          installationId: cols.installationId,
          itemKind,
          itemKey,
        },
      });
      return res.count > 0;
    },
  };
};

export type DriftReviewView = {
  id: string;
  catalogVersionId: string | null;
  installationId: string | null;
  itemKind: (typeof ITEM_KINDS)[number];
  itemKey: string;
  oldHash: string | null;
  newHash: string;
  newDefinition: Record<string, unknown>;
  guardResults: unknown[];
  status: (typeof REVIEW_STATUSES)[number];
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
};

const toReview = (r: DriftReview): DriftReviewView => ({
  id: r.id,
  catalogVersionId: r.catalogVersionId,
  installationId: r.installationId,
  itemKind: itemKindSchema.parse(r.itemKind),
  itemKey: r.itemKey,
  oldHash: r.oldHash === null ? null : bytesToHex(r.oldHash),
  newHash: bytesToHex(r.newHash),
  newDefinition: jsonObjectSchema.parse(r.newDefinition),
  guardResults: z.array(z.unknown()).parse(r.guardResults),
  status: z.enum(REVIEW_STATUSES).parse(r.status),
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  reason: r.reason,
  createdAt: r.createdAt,
});

/** `drift_reviews`: the queue of changed or added definitions waiting for an owner (13.6). */
export const createDriftReviewRepository = (
  arg: PrismaLike | RepoContext,
  options?: RepoOptions,
) => {
  const ctx = toContext(arg, options);
  const { db } = ctx;
  return {
    async get(id: string): Promise<DriftReviewView | null> {
      const row = await db.driftReview.findUnique({ where: { id } });
      return row ? toReview(row) : null;
    },

    async list(
      filter: {
        status?: DriftReviewView['status'];
        catalogVersionId?: string;
        installationId?: string;
        limit?: number;
        cursor?: string;
      } = {},
    ): Promise<Paged<DriftReviewView>> {
      return paginate(
        filter,
        (take) =>
          db.driftReview.findMany({
            where: {
              ...(filter.status ? { status: filter.status } : {}),
              ...(filter.catalogVersionId ? { catalogVersionId: filter.catalogVersionId } : {}),
              ...(filter.installationId ? { installationId: filter.installationId } : {}),
              ...afterKey('id', 'desc', filter.cursor),
            },
            orderBy: { id: 'desc' },
            take,
          }),
        idCursorOf,
        toReview,
      );
    },

    /** Opens a review; a second report of the same change reuses the open one. */
    open(
      subject: PinSubject,
      input: {
        itemKind: DriftReviewView['itemKind'];
        itemKey: string;
        oldHash: string | null;
        newHash: string;
        newDefinition: Record<string, unknown>;
        guardResults?: unknown[];
      },
    ): Promise<{ review: DriftReviewView; created: boolean }> {
      return mutate(ctx, async (tx, unit) => {
        const cols = subjectColumns(subject);
        const existing = await tx.driftReview.findFirst({
          where: {
            ...cols,
            itemKind: input.itemKind,
            itemKey: input.itemKey,
            newHash: hexToBytes(input.newHash),
            status: 'open',
          },
        });
        if (existing) return { review: toReview(existing), created: false };
        const row = await tx.driftReview.create({
          data: {
            id: newId(),
            ...cols,
            itemKind: input.itemKind,
            itemKey: input.itemKey,
            oldHash: input.oldHash === null ? null : hexToBytes(input.oldHash),
            newHash: hexToBytes(input.newHash),
            newDefinition: toJson(input.newDefinition),
            guardResults: toJson(input.guardResults ?? []),
          },
        });
        if (cols.catalogVersionId) {
          const v = await tx.catalogVersion.findUnique({
            where: { id: cols.catalogVersionId },
            select: { entryId: true },
          });
          if (v) unit.bump('catalog', v.entryId);
        }
        if (cols.installationId) unit.bump('installation', cols.installationId);
        return { review: toReview(row), created: true };
      });
    },

    /**
     * Approves or rejects an open review. Approval re-pins the item to the reviewed definition in the same
     * transaction and bumps the configuration version so workers recompile (13.6).
     */
    decide(
      id: string,
      decision: { status: 'approved' | 'rejected'; decidedBy: string; reason?: string | null },
      audit?: AuditContext,
    ): Promise<DriftReviewView> {
      return mutate(ctx, async (tx, unit) => {
        const current = await tx.driftReview.findUnique({ where: { id } });
        if (!current) throw new NotFoundError('drift review', id);
        const res = await tx.driftReview.updateMany({
          where: { id, status: 'open' },
          data: {
            status: decision.status,
            decidedBy: decision.decidedBy,
            decidedAt: new Date(),
            reason: decision.reason ?? null,
          },
        });
        if (res.count === 0)
          throw new ConflictError('drift review was already decided', {
            id,
            status: current.status,
          });
        if (decision.status === 'approved') {
          await upsertPinSql(tx, {
            catalogVersionId: current.catalogVersionId,
            installationId: current.installationId,
            itemKind: current.itemKind,
            itemKey: current.itemKey,
            hash: current.newHash,
            definition: current.newDefinition,
            approvedBy: decision.decidedBy,
          });
          if (current.catalogVersionId) {
            const v = await tx.catalogVersion.findUnique({
              where: { id: current.catalogVersionId },
              select: { entryId: true },
            });
            if (v) unit.bump('catalog', v.entryId);
          }
          if (current.installationId) unit.bump('installation', current.installationId);
        }
        const row = await tx.driftReview.findUniqueOrThrow({ where: { id } });
        unit.audit(audit, {
          action: `drift_review.${decision.status}`,
          targetType: 'drift_review',
          targetId: id,
          diff: {
            before: { status: 'open' },
            after: {
              status: decision.status,
              item: `${current.itemKind}:${current.itemKey}`,
              reason: decision.reason ?? null,
            },
          },
        });
        return toReview(row);
      });
    },
  };
};

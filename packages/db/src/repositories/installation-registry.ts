import { type ServerSpec, serverSpecSchema } from '@bastion-mcp/core';
import { z } from 'zod';
import type { Prisma } from '../generated/client';
import { type CatalogVisibility, versionRuntimeSchema, visibilitySchema } from './catalog';
import { statusSchema, stringRecord } from './installations';
import {
  compact,
  jsonObjectSchema,
  type PrismaLike,
  type RepoContext,
  type RepoOptions,
  toContext,
} from './support';

// --- router mapping: InstallationInfo (7.2, 11.4) ------------------------------------------------------------------------------

export type InstallationOwnerInfo =
  | { kind: 'user'; id: string }
  | { kind: 'team'; id: string; slug: string }
  | { kind: 'service'; id: string; teamId?: string };

/** `InstallationInfo` of `@bastion-mcp/router`, parameterised by the overrides document type `L`. */
export type InstallationInfoRow<L = Record<string, unknown>> = {
  id: string;
  slug: string;
  toolPrefix: string;
  displayName: string;
  owner: InstallationOwnerInfo;
  enabled: boolean;
  /** `catalog`, `manual`, `test`...: a `test` installation is only served on its own endpoint. */
  origin?: string;
  status: 'ready' | 'needs_setup' | 'reconnect_required' | 'error' | 'disabled';
  catalogEntryId: string;
  catalogVersionId?: string;
  catalogSlug?: string;
  layers: { catalog?: L | undefined; installation?: L | undefined };
  pinned: boolean;
  capabilities: {
    tools?: boolean;
    prompts?: boolean;
    resources?: boolean;
    completions?: boolean;
    subscribe?: boolean;
  };
  needsAuth: boolean;
  policy?: {
    id: string;
    catalogEntryId: string;
    ownerUserId?: string;
    ownerTeamId?: string;
    ownerServiceId?: string;
    ownerServiceTeamId?: string;
    catalogEntry?: {
      ownerTeamId?: string;
      visibility?: CatalogVisibility;
      risk: 'low' | 'medium' | 'high';
    };
  };
};

export type PrincipalRef = { id: string; type: 'user' | 'service'; teamIds: readonly string[] };

export type RouterRepositoryOptions<L> = {
  /** Validates an overrides document read from JSONB (`overridesDocumentSchema.parse` of `@bastion-mcp/overrides`). */
  parseOverrides?: (raw: unknown) => L;
};

const authMode = (spec: unknown): string | undefined => {
  const parsed = z.object({ auth: z.object({ mode: z.string() }).optional() }).safeParse(spec);
  return parsed.success ? parsed.data.auth?.mode : undefined;
};

/**
 * The db side of the router's `InstallationInfo` (7.2): the installations a principal sees on its default
 * endpoint, with the catalog layer of overrides, the effective version (follow-current unless pinned),
 * `needsAuth` (OAuth upstream without a valid token) and policy attributes.
 *
 * Personal installations have no catalog entry; `catalogEntryId` carries the installation id so it stays a
 * unique, never-matching dependency key. Capabilities come from the newest snapshot's non-empty lists and
 * default to "everything" until a snapshot exists.
 */
export const createRouterRepository = <L = Record<string, unknown>>(
  arg: PrismaLike | RepoContext,
  options: RepoOptions & RouterRepositoryOptions<L> = {},
) => {
  const { db } = toContext(arg, options);
  const parse = (options.parseOverrides ??
    ((raw: unknown) => jsonObjectSchema.parse(raw) as L)) as (raw: unknown) => L;
  const layerOf = (raw: unknown): L | undefined => {
    const obj = jsonObjectSchema.safeParse(raw);
    return obj.success && Object.keys(obj.data).length > 0 ? parse(obj.data) : undefined;
  };

  const mapRows = async (
    rows: Prisma.InstallationGetPayload<{
      include: { catalogEntry: true; catalogVersion: true };
    }>[],
    principal: PrincipalRef,
  ): Promise<InstallationInfoRow<L>[]> => {
    const teamIds = [...new Set(rows.filter((r) => r.ownerType === 'team').map((r) => r.ownerId))];
    const teams = await db.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, slug: true },
    });
    const teamSlug = new Map(teams.map((t) => [t.id, t.slug]));
    const serviceIds = rows.filter((r) => r.ownerType === 'service').map((r) => r.ownerId);
    const accounts = await db.serviceAccount.findMany({
      where: { id: { in: serviceIds } },
      select: { id: true, teamId: true },
    });
    const serviceTeam = new Map(accounts.map((a) => [a.id, a.teamId]));
    const tokens = await db.upstreamToken.findMany({
      where: {
        principalId: principal.id,
        installationId: { in: rows.map((r) => r.id) },
        status: 'valid',
      },
      select: { installationId: true },
    });
    const hasToken = new Set(tokens.map((t) => t.installationId));
    const currentIds = rows
      .map((r) => r.catalogEntry?.currentVersionId)
      .filter((v): v is string => typeof v === 'string');
    const versions = await db.catalogVersion.findMany({ where: { id: { in: currentIds } } });
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const snapshots = await db.upstreamSnapshot.findMany({
      where: { installationId: { in: rows.map((r) => r.id) } },
      orderBy: { capturedAt: 'desc' },
      select: { installationId: true, tools: true, prompts: true, resources: true },
    });
    const snapshotOf = new Map<string, (typeof snapshots)[number]>();
    for (const s of snapshots)
      if (s.installationId && !snapshotOf.has(s.installationId))
        snapshotOf.set(s.installationId, s);
    const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

    return rows.map((r): InstallationInfoRow<L> => {
      const owner: InstallationOwnerInfo =
        r.ownerType === 'team'
          ? { kind: 'team', id: r.ownerId, slug: teamSlug.get(r.ownerId) ?? '' }
          : r.ownerType === 'service'
            ? {
                kind: 'service',
                id: r.ownerId,
                ...(serviceTeam.has(r.ownerId)
                  ? { teamId: serviceTeam.get(r.ownerId) as string }
                  : {}),
              }
            : { kind: 'user', id: r.ownerId };
      const current = r.catalogEntry?.currentVersionId
        ? versionById.get(r.catalogEntry.currentVersionId)
        : undefined;
      const version = r.pinnedVersion || !current ? r.catalogVersion : current;
      const spec = version?.serverSpec ?? r.personalSpec;
      const snap = snapshotOf.get(r.id);
      const catalogLayer = version ? layerOf(version.overrides) : undefined;
      const installationLayer = layerOf(r.overrides);
      const entry = r.catalogEntry;
      const info: InstallationInfoRow<L> = {
        id: r.id,
        slug: r.slug,
        toolPrefix: r.toolPrefix,
        displayName: r.displayName,
        owner,
        enabled: r.enabled,
        origin: r.origin,
        status: statusSchema.parse(r.status),
        catalogEntryId: r.catalogEntryId ?? r.id,
        ...(version ? { catalogVersionId: version.id } : {}),
        ...(entry ? { catalogSlug: entry.slug } : {}),
        layers: { catalog: catalogLayer, installation: installationLayer },
        pinned: r.pinnedVersion,
        capabilities: snap
          ? {
              tools: nonEmpty(snap.tools),
              prompts: nonEmpty(snap.prompts),
              resources: nonEmpty(snap.resources),
            }
          : { tools: true, prompts: true, resources: true },
        needsAuth: authMode(spec) === 'oauth' && !hasToken.has(r.id),
        policy: {
          id: r.id,
          catalogEntryId: r.catalogEntryId ?? r.id,
          ...(r.ownerType === 'user' ? { ownerUserId: r.ownerId } : {}),
          ...(r.ownerType === 'team' ? { ownerTeamId: r.ownerId } : {}),
          ...(r.ownerType === 'service'
            ? {
                ownerServiceId: r.ownerId,
                ...(serviceTeam.has(r.ownerId)
                  ? { ownerServiceTeamId: serviceTeam.get(r.ownerId) as string }
                  : {}),
              }
            : {}),
          ...(entry
            ? {
                catalogEntry: {
                  ...(entry.ownerTeamId ? { ownerTeamId: entry.ownerTeamId } : {}),
                  visibility: visibilitySchema.parse(entry.visibility),
                  risk: z.enum(['low', 'medium', 'high']).parse(entry.risk),
                },
              }
            : {}),
        },
      };
      return info;
    });
  };

  const include = { catalogEntry: true, catalogVersion: true } as const;

  return {
    /**
     * Installations of the principal in default-endpoint order: own first, then team installations by team, then
     * by creation (7.1). Team installations the user hid (`installation_prefs.hidden`) are left out.
     */
    async listForPrincipal(
      principal: PrincipalRef,
      opts: { includeHidden?: boolean } = {},
    ): Promise<InstallationInfoRow<L>[]> {
      const hidden =
        principal.type === 'user' && !opts.includeHidden
          ? (
              await db.installationPref.findMany({
                where: { userId: principal.id, hidden: true },
                select: { installationId: true },
              })
            ).map((p) => p.installationId)
          : [];
      const rows = await db.installation.findMany({
        where: {
          id: { notIn: hidden },
          OR: [
            { ownerType: principal.type === 'user' ? 'user' : 'service', ownerId: principal.id },
            ...(principal.teamIds.length > 0
              ? [{ ownerType: 'team', ownerId: { in: [...principal.teamIds] } }]
              : []),
          ],
        },
        include,
        orderBy: { id: 'asc' },
      });
      const rank = (r: { ownerType: string }): number => (r.ownerType === 'team' ? 1 : 0);
      rows.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
      return mapRows(rows, principal);
    },

    async getInfo(
      installationId: string,
      principal: PrincipalRef,
    ): Promise<InstallationInfoRow<L> | null> {
      const row = await db.installation.findUnique({ where: { id: installationId }, include });
      return row ? ((await mapRows([row], principal))[0] ?? null) : null;
    },

    /** `/mcp/c/{catalogSlug}` (7.1): the principal's installations of one catalog entry. */
    async listForCatalogSlug(
      principal: PrincipalRef,
      catalogSlug: string,
    ): Promise<InstallationInfoRow<L>[]> {
      const all = await this.listForPrincipal(principal);
      return all.filter((i) => i.catalogSlug === catalogSlug);
    },
  };
};

// --- mcp-upstream: ResolvedInstallation -------------------------------------------------------------------------------------------

export type ResolvedInstallationRow = {
  installationId: string;
  slug: string;
  catalogEntryId: string;
  catalogVersionId: string;
  catalogEntryName: string;
  origin: 'admin' | 'personal';
  ownerUserId: string | null;
  spec: ServerSpec;
  variables: Record<string, string>;
  configHash: string;
  enableSampling: boolean;
  enableRoots: boolean;
  roots: string[];
  extensions: { allow?: string[]; block?: string[] };
  replicas: number;
  listTtlMs?: number;
};

/**
 * `InstallationRegistry` of `@bastion-mcp/mcp-upstream`. `configHash` is `computeConfigHash` of the router, injected
 * because db may not import it.
 */
export const createInstallationRegistry = (
  arg: PrismaLike | RepoContext,
  deps: {
    configHash: (input: {
      installationId: string;
      spec: ServerSpec;
      variables: Record<string, string>;
      catalogVersionId: string;
    }) => string;
  },
  options?: RepoOptions,
) => {
  const { db } = toContext(arg, options);
  return {
    async get(installationId: string): Promise<ResolvedInstallationRow | null> {
      const inst = await db.installation.findUnique({
        where: { id: installationId },
        include: { catalogEntry: true, catalogVersion: true },
      });
      if (!inst) return null;
      let version = inst.catalogVersion;
      const entry = inst.catalogEntry;
      if (entry && !inst.pinnedVersion && entry.currentVersionId) {
        version = await db.catalogVersion.findUnique({ where: { id: entry.currentVersionId } });
      }
      const rawSpec = version?.serverSpec ?? inst.personalSpec;
      if (rawSpec === null || rawSpec === undefined) return null;
      const spec = serverSpecSchema.parse(rawSpec);
      const variables = Object.fromEntries(
        Object.entries(stringRecord.parse(inst.variables)).map(([k, v]) => [k, String(v)]),
      );
      const runtime = versionRuntimeSchema.parse(version?.runtime ?? {});
      const versionId = version?.id ?? inst.id;
      return {
        installationId: inst.id,
        slug: inst.slug,
        catalogEntryId: inst.catalogEntryId ?? inst.id,
        catalogVersionId: versionId,
        catalogEntryName: entry?.slug ?? 'personal',
        origin: inst.personalSpec === null ? 'admin' : 'personal',
        ownerUserId: inst.ownerType === 'user' ? inst.ownerId : null,
        spec,
        variables,
        configHash: deps.configHash({
          installationId: inst.id,
          spec,
          variables,
          catalogVersionId: versionId,
        }),
        enableSampling: runtime.enableSampling,
        enableRoots: runtime.enableRoots,
        roots: runtime.roots ?? (spec.type === 'package' ? ['file:///workspace'] : []),
        extensions: compact<{ allow?: string[]; block?: string[] }>(runtime.extensions),
        replicas: runtime.replicas,
        ...(runtime.listTtlMs === undefined ? {} : { listTtlMs: runtime.listTtlMs }),
      };
    },
  };
};

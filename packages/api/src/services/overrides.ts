import {
  emptyOverrides,
  filterUserLayer,
  type OverridesDocument,
  type PreviewResult,
  parseOverrides,
  previewOverrides,
  type UpstreamDefinitions,
  type UserOverridesLevel,
} from '@bastion-mcp/overrides';
import { z } from 'zod';
import { ConflictApiError, NotFoundApiError, ValidationApiError } from '../errors';
import type { Row } from '../ports/store';
import type { previewBodySchema } from '../schemas/installations';
import type { ReadCtx, WriteCtx } from './crud';
import { loadLayers, requireInstallation } from './installations';
import { installationResource } from './resources';

export type Rejection = { path: string; reason: string };

/** Parses an untrusted overrides document; failures are 400 problems with the JSON pointer of each issue. */
export const parseDoc = (input: unknown): OverridesDocument => {
  const parsed = parseOverrides(input);
  if (!parsed.ok) {
    throw new ValidationApiError(
      'the overrides document is invalid',
      parsed.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  return parsed.doc;
};

const asDoc = (value: unknown): OverridesDocument => {
  const parsed = parseOverrides(value ?? {});
  return parsed.ok ? parsed.doc : emptyOverrides();
};

const level = z.enum(['none', 'cosmetic', 'full']).catch('cosmetic');

/** The installation layer is bounded by the entry's `userOverrides`; personal installs have no entry (12.1). */
export const levelFor = async (
  ctx: Pick<ReadCtx, 'deps'>,
  installation: Row,
): Promise<UserOverridesLevel> => {
  const entryId =
    typeof installation.catalogEntryId === 'string' ? installation.catalogEntryId : null;
  if (!entryId) return 'full';
  const entry = await ctx.deps.store.get('catalog_entries', entryId);
  return level.parse(entry?.userOverrides);
};

// --- catalog layer ------------------------------------------------------------------------------------

const requireVersion = async (
  store: ReadCtx['deps']['store'],
  entryId: string,
  versionId: string,
) => {
  const version = await store.get('catalog_versions', versionId);
  if (!version || version.entryId !== entryId) throw new NotFoundApiError('catalog version');
  return version;
};

export const catalogOverridesVersion = async (
  deps: ReadCtx['deps'],
  entryId: string,
  versionId: string,
): Promise<string | null> => {
  const version = await deps.store.get('catalog_versions', versionId);
  return version && version.entryId === entryId ? version.updatedAt : null;
};

export const getCatalogOverrides = async (
  ctx: Pick<ReadCtx, 'deps'>,
  entryId: string,
  versionId: string,
) => {
  const version = await requireVersion(ctx.deps.store, entryId, versionId);
  return {
    doc: asDoc(version.overrides),
    updatedAt: version.updatedAt,
    rejected: [] as Rejection[],
  };
};

/** Published versions are frozen (11.1), so only draft versions take override edits. */
export const putCatalogOverrides = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  input: unknown,
) => {
  const version = await requireVersion(ctx.tx.store, entryId, versionId);
  if (version.status === 'published') {
    throw new ConflictApiError(
      'published versions are frozen; create a new version',
      'version_frozen',
    );
  }
  const doc = parseDoc(input);
  const row = await ctx.tx.store.update('catalog_versions', versionId, { overrides: doc });
  await ctx.tx.audit({
    action: 'catalog.overrides.update',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: {
      entryId,
      tools: Object.keys(doc.tools).length,
      prompts: Object.keys(doc.prompts).length,
    },
  });
  ctx.tx.configChanged('catalog');
  return { doc, updatedAt: row.updatedAt, rejected: [] as Rejection[] };
};

// --- installation layer -------------------------------------------------------------------------------

export const getInstallationOverrides = async (ctx: Pick<ReadCtx, 'deps'>, id: string) => {
  const row = await requireInstallation(ctx.deps, id);
  return {
    doc: asDoc(row.overrides),
    updatedAt: row.updatedAt,
    userOverrides: await levelFor(ctx, row),
    rejected: [] as Rejection[],
  };
};

/** Saves what `userOverrides` allows and reports every rejected path (12.1). */
export const putInstallationOverrides = async (ctx: WriteCtx, id: string, input: unknown) => {
  const row = await requireInstallation(ctx.deps, id, ctx.tx.store);
  const lvl = await levelFor(ctx, row);
  const { doc, rejected } = filterUserLayer(parseDoc(input), lvl);
  const updated = await ctx.tx.store.update('installations', id, { overrides: doc });
  await ctx.tx.audit({
    action: 'installation.overrides.update',
    targetType: 'installation',
    targetId: id,
    diff: { level: lvl, rejected: rejected.length },
  });
  ctx.tx.configChanged('installations');
  return { doc, updatedAt: updated.updatedAt, userOverrides: lvl, rejected };
};

// --- preview ------------------------------------------------------------------------------------------

type PreviewBody = z.output<typeof previewBodySchema>;

/** `POST /overrides/preview`: final definitions and the diff for an unsaved document (12.5). */
export const preview = async (
  ctx: ReadCtx & { signal?: AbortSignal | undefined },
  body: PreviewBody,
): Promise<PreviewResult & { rejected: Rejection[] }> => {
  const doc = parseDoc(body.doc);
  let upstream: UpstreamDefinitions = (body.upstream ?? {}) as UpstreamDefinitions;
  let catalogLayer: OverridesDocument | undefined;
  let installationLayer: OverridesDocument | undefined;
  let rejected: Rejection[] = [];
  let slug: string | undefined;

  if (body.installationId !== undefined) {
    const row = await requireInstallation(ctx.deps, body.installationId);
    ctx.authorize('installation.manage', installationResource(row));
    slug = typeof row.slug === 'string' ? row.slug : undefined;
    const layers = await loadLayers(ctx.deps, row);
    catalogLayer = layers.catalog;
    installationLayer = layers.installation;
    if (body.upstream === undefined) {
      const out = await ctx.deps.installations.definitions.listItems(
        row.id,
        ctx.principal.id,
        ctx.signal,
      );
      if (out.status !== 'ok') {
        throw new ConflictApiError(
          `upstream definitions are not available (${out.code})`,
          'upstream_unavailable',
        );
      }
      upstream = {
        ...(out.items.instructions === undefined ? {} : { instructions: out.items.instructions }),
        tools: out.items.tools,
        prompts: out.items.prompts,
        resources: out.items.resources,
        resourceTemplates: out.items.resourceTemplates,
      };
    }
  }

  if (body.layer === 'catalog') {
    catalogLayer = doc;
  } else {
    const lvl: UserOverridesLevel = 'full';
    const filtered = filterUserLayer(
      doc,
      body.installationId ? await levelForInstallation(ctx, body.installationId) : lvl,
    );
    installationLayer = filtered.doc;
    rejected = filtered.rejected;
  }
  const result = previewOverrides(
    upstream,
    { catalog: catalogLayer, installation: installationLayer },
    slug === undefined ? {} : { installationSlug: slug },
  );
  return { ...result, rejected };
};

const levelForInstallation = async (
  ctx: Pick<ReadCtx, 'deps'>,
  id: string,
): Promise<UserOverridesLevel> => levelFor(ctx, await requireInstallation(ctx.deps, id));

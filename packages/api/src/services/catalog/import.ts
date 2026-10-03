import { slugify } from '@bastion-mcp/core';
import { classifyFile, normalizePath } from '@bastion-mcp/plugins';
import {
  deriveInstallForm,
  importFromClientConfig,
  importFromServerJson,
  riskFromTrust,
} from '@bastion-mcp/registry';
import { ApiError, ConflictApiError, NotFoundApiError } from '../../errors';
import type { ImportedCatalogDraft } from '../../ports/catalog';
import type { ImportBody } from '../../schemas/catalog';
import { nowIso, type WriteCtx } from '../crud';
import { decodeBase64, fileRowId } from './files';

// --- import (11.3, 25.2) -----------------------------------------------------------------------------------

type Draft = {
  kind: 'mcp_server' | 'skill' | 'plugin';
  name: string;
  description: string;
  spec: unknown;
  installForm: unknown;
  risk: 'low' | 'medium' | 'high';
  label: string;
  files: Array<{ path: string; content: Uint8Array }>;
  source: Record<string, unknown>;
  warnings: string[];
};

const lastSegment = (name: string): string => name.split('/').pop() ?? name;

const unsupported = (detail: string) => new ApiError('unsupported_server', detail, 422);

const fromServerJson = (input: unknown, prefer: 'remote' | 'package' | undefined): Draft => {
  const { serverJson, mapping } = importFromServerJson(input, prefer ? { prefer } : {});
  if (!mapping.installable) throw unsupported(mapping.detail);
  return {
    kind: 'mcp_server',
    name: serverJson.title ?? lastSegment(serverJson.name),
    description: serverJson.description,
    spec: mapping.spec,
    installForm: mapping.form,
    risk: 'medium',
    label: serverJson.version,
    files: [],
    source: { kind: 'server_json', serverName: serverJson.name, version: serverJson.version },
    warnings: mapping.warnings,
  };
};

const fromDraftFiles = (draft: ImportedCatalogDraft, source: Record<string, unknown>): Draft => ({
  kind: draft.kind,
  name: draft.name,
  description: draft.description ?? '',
  spec: draft.spec ?? null,
  installForm: draft.spec ? deriveInstallForm(draft.spec) : { variables: [], secrets: [] },
  risk: 'medium',
  label: '1',
  files: (draft.files ?? []).map((f) => ({
    path: normalizePath(f.path),
    content: decodeBase64(f.contentBase64),
  })),
  source,
  warnings: draft.warnings,
});

const resolveDraft = async (
  ctx: WriteCtx,
  source: ImportBody,
  signal?: AbortSignal,
): Promise<Draft> => {
  const { deps } = ctx;
  switch (source.kind) {
    case 'server_json':
      return fromServerJson(source.serverJson, source.prefer);
    case 'client_config': {
      const imported = await importFromClientConfig(source.snippet, {
        resolver: deps.catalog.versions,
        ...(signal ? { signal } : {}),
      });
      return {
        kind: 'mcp_server',
        name: source.name ?? imported.name,
        description: imported.description ?? '',
        spec: imported.spec,
        installForm: deriveInstallForm(imported.spec),
        risk: 'medium',
        label: '1',
        files: [],
        source: { kind: 'client_config' },
        warnings: imported.warnings,
      };
    }
    case 'registry': {
      const registry = await deps.registry.sources.get(source.sourceId);
      if (!registry) throw new NotFoundApiError('registry source');
      const rows = await deps.registry.servers.list(source.sourceId, { name: source.name });
      const row = rows.find((r) => r.version === source.version);
      if (!row) throw new NotFoundApiError('registry server');
      const draft = fromServerJson(row.serverJson, undefined);
      return {
        ...draft,
        risk: riskFromTrust(registry.trust),
        source: {
          kind: 'registry',
          registrySourceId: source.sourceId,
          serverName: source.name,
          version: source.version,
        },
      };
    }
    case 'zip':
      return fromDraftFiles(
        await deps.catalog.imports.fromZip(decodeBase64(source.contentBase64)),
        {
          kind: 'zip',
        },
      );
    case 'git':
      return fromDraftFiles(await deps.catalog.imports.fromGit(source.url, source.ref), {
        kind: 'git',
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
      });
  }
};

const uniqueSlug = async (ctx: WriteCtx, wanted: string): Promise<string> => {
  const base = slugify(wanted) || 'entry';
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if ((await ctx.tx.store.find('catalog_entries', { slug: candidate })).length === 0)
      return candidate;
  }
  throw new ConflictApiError('could not find a free slug', { code: 'slug_taken' });
};

/** `POST /catalog/import`: creates a draft entry and version from any supported source (11.3, 25.2). */
export const importEntry = async (
  ctx: WriteCtx,
  body: {
    ownerTeamId?: string | null | undefined;
    visibility?: { org: boolean; teamIds: string[]; userIds: string[] } | undefined;
    slug?: string | undefined;
    source: ImportBody;
  },
  signal?: AbortSignal,
) => {
  const draft = await resolveDraft(ctx, body.source, signal);
  const slug = body.slug ? await uniqueSlug(ctx, body.slug) : await uniqueSlug(ctx, draft.name);
  const entry = await ctx.tx.store.insert('catalog_entries', {
    id: ctx.deps.newId(),
    slug,
    kind: draft.kind,
    displayName: draft.name,
    description: draft.description,
    tags: [],
    ownerTeamId: body.ownerTeamId ?? null,
    visibility: body.visibility ?? { org: false, teamIds: [], userIds: [] },
    status: 'draft',
    risk: draft.risk,
    source: draft.source,
    currentVersionId: null,
    autoUpgrade: true,
    userOverrides: 'cosmetic',
    onDrift: 'hideChanged',
    createdBy: ctx.principal.id,
    createdAt: nowIso(ctx.deps),
  });
  const version = await ctx.tx.store.insert('catalog_versions', {
    id: ctx.deps.newId(),
    entryId: entry.id,
    label: draft.label,
    serverSpec: draft.spec,
    installForm: draft.installForm,
    status: 'draft',
    changelog: null,
    testResult: null,
    createdBy: ctx.principal.id,
    createdAt: nowIso(ctx.deps),
  });
  for (const file of draft.files) {
    const mode = file.content[0] === 0x23 && file.content[1] === 0x21 ? 'executable' : 'file';
    const classified = classifyFile({ path: file.path, content: file.content, mode });
    const sha = await ctx.deps.catalog.blobs.put(file.content);
    await ctx.tx.store.upsert('catalog_files', fileRowId(version.id, file.path), {
      catalogVersionId: version.id,
      path: file.path,
      blobSha256: sha,
      mode,
      classification: classified.classification,
      size: file.content.length,
    });
  }
  await ctx.tx.audit({
    action: 'catalog.import',
    targetType: 'catalog_entry',
    targetId: entry.id,
    diff: { source: draft.source, files: draft.files.length },
  });
  ctx.tx.configChanged('catalog');
  return { entry, version, warnings: draft.warnings };
};

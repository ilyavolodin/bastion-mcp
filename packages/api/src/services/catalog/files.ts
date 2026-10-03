import { PLUGIN_LIMITS } from '@bastion-mcp/core';
import { classifyFile, normalizePath } from '@bastion-mcp/plugins';
import { ApiError, NotFoundApiError, ValidationApiError } from '../../errors';
import type { Row } from '../../ports/store';
import type { WriteCtx } from '../crud';
import { entries } from './entries';
import type { Deps } from './shared';
import { approvalOf, assertDraft, requireVersion } from './versions';

// --- files (25.2) -----------------------------------------------------------------------------------------

export const decodeBase64 = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new ValidationApiError('contentBase64 is not valid base64', [
      { path: '/contentBase64', message: 'invalid base64' },
    ]);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > PLUGIN_LIMITS.maxFileBytes) {
    throw new ApiError(
      'file_too_large',
      `files are limited to ${PLUGIN_LIMITS.maxFileBytes} bytes`,
      413,
    );
  }
  return new Uint8Array(bytes);
};

const fileView = (row: Row) => ({
  id: row.id,
  path: row.path,
  mode: row.mode,
  classification: row.classification,
  sha256: row.blobSha256,
  size: row.size ?? null,
  updatedAt: row.updatedAt,
});

export const fileRowId = (versionId: string, path: string): string => `${versionId}:${path}`;

export const listFiles = async (ctx: Deps, entryId: string, versionId: string) => {
  const entry = await entries.require(ctx, entryId);
  await requireVersion(ctx, entryId, versionId);
  const rows = await ctx.deps.store.find('catalog_files', { catalogVersionId: versionId });
  const items = rows.map(fileView).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const approval = items.length > 0 ? await approvalOf(ctx.deps, entry, versionId) : null;
  return { items, nextCursor: null, approval };
};

export const getFile = async (ctx: Deps, entryId: string, versionId: string, rawPath: string) => {
  await requireVersion(ctx, entryId, versionId);
  const path = normalizePath(rawPath);
  const row = await ctx.deps.store.get('catalog_files', fileRowId(versionId, path));
  if (!row) throw new NotFoundApiError('file');
  const bytes = await ctx.deps.catalog.blobs.get(String(row.blobSha256));
  if (!bytes) throw new ApiError('blob_missing', 'the file content is missing', 500);
  return { ...fileView(row), contentBase64: Buffer.from(bytes).toString('base64') };
};

export const putFile = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  rawPath: string,
  body: { contentBase64: string; mode: 'file' | 'executable' },
) => {
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  const path = normalizePath(rawPath);
  const content = decodeBase64(body.contentBase64);
  const classified = classifyFile({ path, content, mode: body.mode });
  const sha = await ctx.deps.catalog.blobs.put(content);
  const row = await ctx.tx.store.upsert('catalog_files', fileRowId(versionId, path), {
    catalogVersionId: versionId,
    path,
    blobSha256: sha,
    mode: body.mode,
    classification: classified.classification,
    size: content.length,
  });
  // A changed file invalidates any earlier approval: it must be reviewed again (25.2).
  await ctx.tx.store.remove('executable_approvals', versionId);
  await ctx.tx.audit({
    action: 'catalog.file.put',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: {
      path,
      sha256: sha,
      classification: classified.classification,
      reason: classified.reason,
    },
  });
  return fileView(row);
};

export const deleteFile = async (
  ctx: WriteCtx,
  entryId: string,
  versionId: string,
  rawPath: string,
): Promise<void> => {
  const version = await requireVersion(ctx, entryId, versionId, ctx.tx.store);
  assertDraft(version);
  const path = normalizePath(rawPath);
  const removed = await ctx.tx.store.remove('catalog_files', fileRowId(versionId, path));
  if (!removed) throw new NotFoundApiError('file');
  await ctx.tx.store.remove('executable_approvals', versionId);
  await ctx.tx.audit({
    action: 'catalog.file.delete',
    targetType: 'catalog_version',
    targetId: versionId,
    diff: { path },
  });
};

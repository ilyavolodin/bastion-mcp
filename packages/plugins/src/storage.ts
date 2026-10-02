import { classifyFile } from './classify';
import { PluginValidationError } from './errors';
import { enforceLimits } from './paths';
import type { BlobStore, CatalogFileStore, StoredFileRow } from './ports';
import { type PluginFile, sortFiles } from './types';

/** Stores a draft version's files: bodies in the blob store, rows (with classification) in `catalog_files`. */
export const saveVersionFiles = async (
  stores: { blobs: BlobStore; files: CatalogFileStore },
  catalogVersionId: string,
  files: readonly PluginFile[],
): Promise<StoredFileRow[]> => {
  enforceLimits(files);
  const rows: StoredFileRow[] = [];
  for (const file of sortFiles(files)) {
    const blobSha256 = await stores.blobs.put(file.content);
    rows.push({
      path: file.path,
      blobSha256,
      mode: file.mode,
      classification: classifyFile(file).classification,
    });
  }
  await stores.files.replace(catalogVersionId, rows);
  return rows;
};

/** Loads a version's files back from the blob store. */
export const loadVersionFiles = async (
  stores: { blobs: BlobStore; files: CatalogFileStore },
  catalogVersionId: string,
): Promise<PluginFile[]> => {
  const rows = await stores.files.list(catalogVersionId);
  const files: PluginFile[] = [];
  for (const row of rows) {
    const content = await stores.blobs.get(row.blobSha256);
    if (!content) throw new PluginValidationError('blob missing', { path: row.path });
    files.push({ path: row.path, content, mode: row.mode });
  }
  return sortFiles(files);
};

import { crc32 } from 'node:zlib';
import { PLUGIN_LIMITS } from '@bastion-mcp/core';
import { type Zippable, unzipSync, zipSync } from 'fflate';
import { PluginValidationError } from './errors';
import { enforceLimits, normalizePath, type PluginLimits } from './paths';
import { type PluginFile, sortFiles } from './types';

type CentralEntry = {
  name: string;
  compressedSize: number;
  size: number;
  crc: number;
  unixMode: number | undefined;
};

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_RATIO = 1000;
/** Ratio is only meaningful above this size; tiny highly compressible files are fine. */
const RATIO_FLOOR_BYTES = 64 * 1024;

const readCentralDirectory = (zip: Uint8Array, maxEntries: number): CentralEntry[] => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PluginValidationError('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new PluginValidationError('zip64 archives are not supported');
  }
  if (count > maxEntries + 1000) throw new PluginValidationError('too many zip entries');
  const entries: CentralEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== CEN_SIG) {
      throw new PluginValidationError('corrupt zip central directory');
    }
    const madeByHost = view.getUint8(offset + 5);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({
      name,
      compressedSize,
      size,
      crc,
      unixMode: madeByHost === 3 ? external >>> 16 : undefined,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const KNOWN_ROOTS = new Set([
  '.claude-plugin',
  '.agents',
  'skills',
  'commands',
  'agents',
  'hooks',
  'output-styles',
  'claude',
  'openai',
  'references',
  'scripts',
  'assets',
]);

/** Removes a single wrapping directory (`my-skill/SKILL.md` -> `SKILL.md`) unless it is a known root. */
export const stripWrapperDirectory = (files: PluginFile[]): PluginFile[] => {
  const roots = new Set(files.map((f) => f.path.split('/')[0]));
  if (roots.size !== 1) return files;
  const [root] = [...roots];
  if (root === undefined || KNOWN_ROOTS.has(root)) return files;
  if (files.some((f) => !f.path.includes('/'))) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
};

/**
 * Imports a zip of a skill or plugin directory (25.3). Zip-slip, symlinks, absolute paths and `..`
 * are rejected, and the 25.2 limits are enforced from the central directory before anything is
 * inflated; inflated sizes are then checked against the declared ones (zip bomb).
 */
export const importZip = (
  zip: Uint8Array,
  options: { limits?: PluginLimits; stripWrapper?: boolean } = {},
): PluginFile[] => {
  const limits = options.limits ?? PLUGIN_LIMITS;
  const entries = readCentralDirectory(zip, limits.maxFiles);
  const wanted = new Map<string, { entry: CentralEntry; path: string; executable: boolean }>();
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // directory entries carry no content
    if (entry.name.includes('\\')) {
      throw new PluginValidationError('zip entry name contains a backslash', { path: entry.name });
    }
    const path = normalizePath(entry.name);
    const fileType = entry.unixMode === undefined ? 0 : entry.unixMode & 0o170000;
    if (fileType === 0o120000) {
      throw new PluginValidationError('symlinks are rejected', { path: entry.name });
    }
    if (fileType !== 0 && fileType !== 0o100000) {
      throw new PluginValidationError('special files are rejected', { path: entry.name });
    }
    if (wanted.has(path)) throw new PluginValidationError('duplicate path', { path });
    if (entry.size > limits.maxFileBytes) {
      throw new PluginValidationError(`file larger than ${limits.maxFileBytes} bytes`, { path });
    }
    declaredTotal += entry.size;
    if (declaredTotal > limits.maxUnpackedBytes) {
      throw new PluginValidationError(`unpacked size above ${limits.maxUnpackedBytes} bytes`);
    }
    if (entry.size > RATIO_FLOOR_BYTES && entry.size / Math.max(1, entry.compressedSize) > MAX_RATIO) {
      throw new PluginValidationError('compression ratio too high (zip bomb)', { path });
    }
    wanted.set(path, {
      entry,
      path,
      executable: entry.unixMode !== undefined && (entry.unixMode & 0o111) !== 0,
    });
    if (wanted.size > limits.maxFiles) {
      throw new PluginValidationError(`more than ${limits.maxFiles} files`);
    }
  }
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip, {
      filter: (info) => !info.name.endsWith('/') && info.originalSize <= limits.maxFileBytes,
    });
  } catch (error) {
    if (error instanceof PluginValidationError) throw error;
    throw new PluginValidationError('corrupt zip archive', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const files: PluginFile[] = [];
  for (const [name, content] of Object.entries(raw)) {
    const meta = wanted.get(normalizePath(name));
    if (!meta) continue;
    if (content.byteLength !== meta.entry.size || crc32(content) !== meta.entry.crc) {
      throw new PluginValidationError('inflated content differs from the declared size or CRC', {
        path: meta.path,
      });
    }
    files.push({ path: meta.path, content, mode: meta.executable ? 'executable' : 'file' });
  }
  if (files.length !== wanted.size) throw new PluginValidationError('zip entries could not be read');
  const result = options.stripWrapper === false ? files : stripWrapperDirectory(files);
  enforceLimits(result, limits);
  return sortFiles(result);
};

/** Fixed DOS timestamp 1980-01-01 00:00:00 (local components, so no timezone dependence). */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

/**
 * Deterministic zip (25.5): entries sorted by path, timestamps fixed at 1980-01-01, no extra fields,
 * Unix modes recorded, the tree at the archive root.
 */
export const exportZip = (files: readonly PluginFile[]): Uint8Array => {
  const zippable: Zippable = {};
  for (const file of sortFiles(files)) {
    zippable[file.path] = [
      file.content,
      {
        level: 6,
        mtime: ZIP_EPOCH,
        os: 3,
        attrs: ((file.mode === 'executable' ? 0o100755 : 0o100644) << 16) >>> 0,
      },
    ];
  }
  return zipSync(zippable);
};

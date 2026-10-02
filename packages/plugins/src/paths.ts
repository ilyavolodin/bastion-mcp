import { PLUGIN_LIMITS } from '@bastion-mcp/core';
import { PluginValidationError } from './errors';
import type { PluginFile } from './types';

/**
 * Normalizes a relative path inside a skill or plugin (25.2): forward slashes only, no empty or `.`
 * segments, and never absolute, `..`, backslashed, NUL-bearing or inside `.git`.
 */
export const normalizePath = (raw: string): string => {
  if (raw.length === 0) throw new PluginValidationError('empty path', { path: raw });
  if (raw.includes('\0')) throw new PluginValidationError('path contains NUL', { path: raw });
  if (raw.includes('\\')) {
    throw new PluginValidationError('path contains a backslash', { path: raw });
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new PluginValidationError('absolute paths are rejected', { path: raw });
  }
  if (raw.endsWith('/')) throw new PluginValidationError('path names a directory', { path: raw });
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new PluginValidationError('`..` is rejected', { path: raw });
    if (segment.toLowerCase() === '.git') {
      throw new PluginValidationError('`.git` paths are rejected', { path: raw });
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new PluginValidationError('empty path', { path: raw });
  return segments.join('/');
};

export type PluginLimits = {
  maxUnpackedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
};

/** Checks the 25.2 limits and path uniqueness; throws `PluginValidationError`. */
export const enforceLimits = (
  files: readonly PluginFile[],
  limits: PluginLimits = PLUGIN_LIMITS,
): void => {
  if (files.length > limits.maxFiles) {
    throw new PluginValidationError(`more than ${limits.maxFiles} files`, { files: files.length });
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (normalizePath(file.path) !== file.path) {
      throw new PluginValidationError('path is not normalized', { path: file.path });
    }
    if (seen.has(file.path)) throw new PluginValidationError('duplicate path', { path: file.path });
    seen.add(file.path);
    if (file.content.byteLength > limits.maxFileBytes) {
      throw new PluginValidationError(`file larger than ${limits.maxFileBytes} bytes`, {
        path: file.path,
      });
    }
    total += file.content.byteLength;
  }
  if (total > limits.maxUnpackedBytes) {
    throw new PluginValidationError(`unpacked size above ${limits.maxUnpackedBytes} bytes`, {
      bytes: total,
    });
  }
};

import { sha256Hex } from '@bastion-mcp/core';

/** A file of a skill or plugin tree. `path` is normalized (see `normalizePath`). */
export type PluginFile = {
  path: string;
  content: Uint8Array;
  mode: 'file' | 'executable';
};

const encoder = new TextEncoder();

export const encodeText = (text: string): Uint8Array => encoder.encode(text);

export const textFile = (
  path: string,
  text: string,
  mode: PluginFile['mode'] = 'file',
): PluginFile => ({ path, content: encodeText(text), mode });

/** Strict UTF-8 decode; `undefined` when the bytes are not valid UTF-8. */
export const decodeUtf8 = (content: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
};

export const fileSha256 = (file: PluginFile): string => sha256Hex(file.content);

export const sortFiles = (files: readonly PluginFile[]): PluginFile[] =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

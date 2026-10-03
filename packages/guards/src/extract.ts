import { canonicalJson, isRecord } from '@bastion-mcp/core';
import { joinIndex, joinKey } from './paths';
import type { TextSegment } from './types';

/** Content extraction (13.3): MCP payloads in, path-addressed text segments out. */

const MAX_DEPTH = 64;
const APP_HTML = /^text\/html\s*;\s*profile\s*=\s*"?mcp-app"?\s*$/i;

/** Every string leaf of a JSON value, addressed by path. */
export const extractStringLeaves = (
  value: unknown,
  prefix: string,
  contentType?: string,
): TextSegment[] => {
  const out: TextSegment[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof node === 'string') {
      if (node.length > 0) {
        out.push(
          contentType === undefined ? { path, text: node } : { path, text: node, contentType },
        );
      }
    } else if (Array.isArray(node)) {
      node.forEach((child, i) => {
        walk(child, joinIndex(path, i), depth + 1);
      });
    } else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, joinKey(path, key), depth + 1);
    }
  };
  walk(value, prefix, 0);
  return out;
};

/** `tools/call` and `prompts/get` arguments (request phase). */
export const extractRequestSegments = (args: unknown, prefix = 'arguments'): TextSegment[] =>
  extractStringLeaves(args, prefix);

/** `resources/read` URI (request phase). */
export const extractUriSegments = (uri: string): TextSegment[] =>
  uri.length > 0 ? [{ path: 'uri', text: uri, contentType: 'uri' }] : [];

const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4);

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const resourceSegments = (
  resource: Record<string, unknown>,
  path: string,
  segments: TextSegment[],
): void => {
  const mime = optionalString(resource.mimeType);
  const text = optionalString(resource.text);
  if (text !== undefined) {
    const seg: TextSegment = { path: `${path}.text`, text };
    if (mime !== undefined) seg.contentType = mime;
    if (mime !== undefined && APP_HTML.test(mime)) seg.appHtml = true;
    segments.push(seg);
    return;
  }
  const blob = optionalString(resource.blob);
  if (blob !== undefined) {
    const seg: TextSegment = { path: `${path}.blob`, text: '', byteLength: base64Bytes(blob) };
    if (mime !== undefined) seg.contentType = mime;
    segments.push(seg);
  }
};

/** Content blocks of a tool result or prompt message; `basePath` is usually `content`. */
export const extractContentBlocks = (blocks: unknown, basePath = 'content'): TextSegment[] => {
  if (!Array.isArray(blocks)) return [];
  const out: TextSegment[] = [];
  blocks.forEach((block, i) => {
    if (!isRecord(block)) return;
    const path = joinIndex(basePath, i);
    const type = optionalString(block.type);
    if (type === 'text') {
      const text = optionalString(block.text);
      if (text !== undefined) out.push({ path: `${path}.text`, text, contentType: 'text' });
    } else if (type === 'resource' && isRecord(block.resource)) {
      resourceSegments(block.resource, `${path}.resource`, out);
    } else if (type === 'resource_link') {
      for (const field of ['name', 'title', 'description'] as const) {
        const text = optionalString(block[field]);
        if (text !== undefined && text.length > 0) {
          out.push({ path: `${path}.${field}`, text, contentType: 'resource_link' });
        }
      }
    } else if (typeof block.data === 'string') {
      // image, audio and other binary blocks are not scanned, but size limits apply.
      const mime = optionalString(block.mimeType);
      out.push({
        path,
        text: '',
        byteLength: base64Bytes(block.data),
        contentType: mime ?? type ?? 'binary',
      });
    }
  });
  return out;
};

/** `structuredContent` as canonical JSON in a single segment. */
export const extractStructuredContent = (
  value: unknown,
  path = 'structuredContent',
): TextSegment[] => {
  if (value === undefined || value === null) return [];
  let text: string;
  try {
    text = canonicalJson(value);
  } catch {
    text = JSON.stringify(value) ?? '';
  }
  return text === '' ? [] : [{ path, text, contentType: 'application/json' }];
};

export type ResultLike = {
  content?: unknown;
  structuredContent?: unknown;
  inputRequests?: unknown;
};

/** Tool result, task result or `input_required` result (response phase). */
export const extractResultSegments = (result: ResultLike): TextSegment[] => [
  ...extractContentBlocks(result.content),
  ...extractStructuredContent(result.structuredContent),
  ...(result.inputRequests === undefined
    ? []
    : extractStringLeaves(result.inputRequests, 'inputRequests')),
];

/** `prompts/get` result messages (response phase). */
export const extractPromptSegments = (messages: unknown): TextSegment[] => {
  if (!Array.isArray(messages)) return [];
  const out: TextSegment[] = [];
  messages.forEach((message, i) => {
    if (!isRecord(message)) return;
    const base = `messages${joinIndex('', i)}.content`;
    const content = message.content;
    if (Array.isArray(content)) out.push(...extractContentBlocks(content, base));
    else out.push(...extractContentBlocks([content], base).map(unwrapSingle(base)));
  });
  return out;
};

/** A single (non-array) content object is addressed without the `[0]` step. */
const unwrapSingle =
  (base: string) =>
  (seg: TextSegment): TextSegment => ({
    ...seg,
    path: seg.path.startsWith(`${base}[0]`) ? base + seg.path.slice(base.length + 3) : seg.path,
  });

/** `resources/read` result contents (response phase). */
export const extractResourceContents = (contents: unknown): TextSegment[] => {
  if (!Array.isArray(contents)) return [];
  const out: TextSegment[] = [];
  contents.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const path = joinIndex('contents', i);
    const mime = optionalString(entry.mimeType);
    const text = optionalString(entry.text);
    if (text !== undefined) {
      const seg: TextSegment = { path: `${path}.text`, text };
      if (mime !== undefined) seg.contentType = mime;
      if (mime !== undefined && APP_HTML.test(mime)) seg.appHtml = true;
      out.push(seg);
    } else if (typeof entry.blob === 'string') {
      const seg: TextSegment = {
        path: `${path}.blob`,
        text: '',
        byteLength: base64Bytes(entry.blob),
      };
      if (mime !== undefined) seg.contentType = mime;
      out.push(seg);
    }
  });
  return out;
};

/** Name, title, description and schema strings of a tool, prompt, resource or template (13.1). */
export const extractDefinitionSegments = (def: Record<string, unknown>): TextSegment[] => {
  const out: TextSegment[] = [];
  for (const field of ['name', 'title', 'description', 'uri', 'uriTemplate'] as const) {
    const text = optionalString(def[field]);
    if (text !== undefined && text.length > 0)
      out.push({ path: field, text, contentType: 'definition' });
  }
  for (const field of ['inputSchema', 'outputSchema', 'arguments'] as const) {
    if (def[field] !== undefined) out.push(...extractStringLeaves(def[field], field, 'schema'));
  }
  if (isRecord(def.annotations)) {
    const title = optionalString(def.annotations.title);
    if (title !== undefined) out.push({ path: 'annotations.title', text: title });
  }
  return out;
};

// --- Size limits and chunking --------------------------------------------------------------------------------

export const totalTextBytes = (segments: readonly TextSegment[]): number => {
  let total = 0;
  for (const s of segments) total += s.byteLength ?? Buffer.byteLength(s.text);
  return total;
};

/**
 * Keeps the first `maxBytes` bytes of text across segments (13.3 `scanPrefix`). Later text is dropped;
 * segment order and indices are preserved, so spans still address the original segments.
 */
export const limitSegmentsToBytes = (
  segments: readonly TextSegment[],
  maxBytes: number,
): { segments: TextSegment[]; truncated: boolean } => {
  let remaining = maxBytes;
  let truncated = false;
  const out = segments.map((seg): TextSegment => {
    if (seg.text === '') return seg;
    const bytes = Buffer.byteLength(seg.text);
    if (bytes <= remaining) {
      remaining -= bytes;
      return seg;
    }
    truncated = true;
    const cut = Buffer.from(seg.text)
      .subarray(0, remaining)
      .toString('utf8')
      .replace(/\uFFFD+$/u, '');
    remaining = 0;
    return { ...seg, text: cut, byteLength: bytes };
  });
  return { segments: out, truncated };
};

export const CHUNK_SIZES = { jev: 8000, llmJudge: 8000, classifier: 1500 } as const;
export const CHUNK_OVERLAP = 200;

export type Chunk = { start: number; end: number };

/** Windows of `size` characters overlapping by `overlap`; never splits a surrogate pair. */
export const chunkText = (text: string, size: number, overlap = CHUNK_OVERLAP): Chunk[] => {
  if (size <= overlap) throw new RangeError('chunk size must exceed the overlap');
  if (text.length === 0) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    chunks.push({ start, end });
    if (end >= text.length) break;
    let next = end - overlap;
    if (next <= start) next = end;
    if (isLowSurrogate(text.charCodeAt(next))) next--;
    start = next > start ? next : end;
  }
  return chunks;
};

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * Hides segments from a guard while keeping indices stable: masked text becomes empty and the
 * original size stays available to the `size` guard.
 */
export const maskSegments = (
  segments: readonly TextSegment[],
  hide: (segment: TextSegment) => boolean,
): TextSegment[] =>
  segments.map((seg) =>
    hide(seg) && seg.text !== ''
      ? { ...seg, text: '', byteLength: seg.byteLength ?? Buffer.byteLength(seg.text) }
      : seg,
  );

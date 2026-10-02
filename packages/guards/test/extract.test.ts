import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  compilePathPattern,
  extractContentBlocks,
  extractDefinitionSegments,
  extractPromptSegments,
  extractRequestSegments,
  extractResourceContents,
  extractResultSegments,
  extractStructuredContent,
  extractUriSegments,
  getAtPath,
  joinKey,
  limitSegmentsToBytes,
  maskSegments,
  parsePath,
  setAtPath,
  totalTextBytes,
} from '../src';

describe('paths (13.3, 13.4)', () => {
  it('13.4 matches arguments.* against one level only', () => {
    const m = compilePathPattern('arguments.*');
    expect(m('arguments.query')).toBe(true);
    expect(m('arguments.rows[0]')).toBe(false);
    expect(m('arguments.a.b')).toBe(false);
    expect(m('content[0].text')).toBe(false);
  });

  it('13.4 matches content[*].text for any block index', () => {
    const m = compilePathPattern('content[*].text');
    expect(m('content[0].text')).toBe(true);
    expect(m('content[12].text')).toBe(true);
    expect(m('content[1].name')).toBe(false);
    expect(m('structuredContent')).toBe(false);
  });

  it('13.4 structuredContent.** matches the segment and everything below it', () => {
    const m = compilePathPattern('structuredContent.**');
    expect(m('structuredContent')).toBe(true);
    expect(m('structuredContent.a.b[3].c')).toBe(true);
    expect(m('content[0].text')).toBe(false);
  });

  it('13.3 quotes keys that are not identifiers and round-trips them', () => {
    const path = joinKey(joinKey('', 'arguments'), 'a.b "c"');
    expect(parsePath(path)).toEqual([
      { kind: 'key', value: 'arguments' },
      { kind: 'key', value: 'a.b "c"' },
    ]);
  });

  it('rejects malformed paths', () => {
    expect(() => parsePath('a[')).toThrow(SyntaxError);
    expect(() => parsePath('a[x]')).toThrow(SyntaxError);
    expect(() => parsePath('a["x"')).toThrow(SyntaxError);
  });

  it('gets and sets by path without mutating the input', () => {
    const root = { content: [{ text: 'a' }, { text: 'b' }], x: { 'k.1': 'v' } };
    expect(getAtPath(root, 'content[1].text')).toBe('b');
    expect(getAtPath(root, 'x["k.1"]')).toBe('v');
    expect(getAtPath(root, 'content[5].text')).toBeUndefined();
    const next = setAtPath(root, 'content[1].text', 'B') as typeof root;
    expect(next.content[1]?.text).toBe('B');
    expect(root.content[1]?.text).toBe('b');
    expect(setAtPath(root, 'nope.x', 1)).toEqual(root);
  });

  it('does not walk the prototype chain', () => {
    expect(getAtPath({}, 'constructor')).toBeUndefined();
    expect(getAtPath({}, '__proto__')).toBeUndefined();
  });
});

describe('content extraction (13.3)', () => {
  it('13.3 extracts text blocks with path addressing', () => {
    const segs = extractContentBlocks([
      { type: 'text', text: 'one' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'three' },
    ]);
    expect(segs.map((s) => s.path)).toEqual(['content[0].text', 'content[1]', 'content[2].text']);
  });

  it('13.3 does not scan binary content but keeps its size for the size guard', () => {
    const [seg] = extractContentBlocks([
      { type: 'image', data: 'A'.repeat(400), mimeType: 'image/png' },
    ]);
    expect(seg?.text).toBe('');
    expect(seg?.byteLength).toBe(300);
    expect(seg?.contentType).toBe('image/png');
  });

  it('13.3 extracts text resource contents, and blobs as binary', () => {
    const segs = extractContentBlocks([
      { type: 'resource', resource: { uri: 'file:///a', mimeType: 'text/plain', text: 'hello' } },
      { type: 'resource', resource: { uri: 'file:///b', blob: 'QUJD' } },
    ]);
    expect(segs[0]).toMatchObject({ path: 'content[0].resource.text', text: 'hello' });
    expect(segs[1]).toMatchObject({ path: 'content[1].resource.blob', text: '', byteLength: 3 });
  });

  it('13.3 extracts resource_link names and descriptions', () => {
    const segs = extractContentBlocks([
      { type: 'resource_link', uri: 'file:///x', name: 'x', description: 'ignore me' },
    ]);
    expect(segs.map((s) => [s.path, s.text])).toEqual([
      ['content[0].name', 'x'],
      ['content[0].description', 'ignore me'],
    ]);
  });

  it('13.3 serializes structuredContent as canonical JSON', () => {
    const [seg] = extractStructuredContent({ b: 1, a: [true, 'x'] });
    expect(seg).toMatchObject({ path: 'structuredContent', text: '{"a":[true,"x"],"b":1}' });
    expect(extractStructuredContent(undefined)).toEqual([]);
  });

  it('13.3 extracts string leaves of request arguments with paths', () => {
    const segs = extractRequestSegments({ query: 'q', n: 5, nested: { list: ['a', { b: 'c' }] } });
    expect(segs.map((s) => s.path)).toEqual([
      'arguments.query',
      'arguments.nested.list[0]',
      'arguments.nested.list[1].b',
    ]);
  });

  it('13.1 addresses the resources/read URI', () => {
    expect(extractUriSegments('file:///etc/passwd')).toEqual([
      { path: 'uri', text: 'file:///etc/passwd', contentType: 'uri' },
    ]);
    expect(extractUriSegments('')).toEqual([]);
  });

  it('13.3 extracts prompt message text for single and array content', () => {
    const segs = extractPromptSegments([
      { role: 'user', content: { type: 'text', text: 'hello' } },
      { role: 'assistant', content: [{ type: 'text', text: 'multi' }] },
    ]);
    expect(segs.map((s) => [s.path, s.text])).toEqual([
      ['messages[0].content.text', 'hello'],
      ['messages[1].content[0].text', 'multi'],
    ]);
  });

  it('13.1 extracts resources/read contents', () => {
    const segs = extractResourceContents([
      { uri: 'a', text: 'body' },
      { uri: 'b', blob: 'QUJD', mimeType: 'application/octet-stream' },
    ]);
    expect(segs.map((s) => s.path)).toEqual(['contents[0].text', 'contents[1].blob']);
  });

  it('6.8 flags MCP Apps HTML bodies', () => {
    const segs = extractContentBlocks([
      {
        type: 'resource',
        resource: { uri: 'ui://x', mimeType: 'text/html;profile=mcp-app', text: '<p>hi</p>' },
      },
    ]);
    expect(segs[0]?.appHtml).toBe(true);
    const [c] = extractResourceContents([
      { uri: 'ui://y', mimeType: 'text/html; profile=mcp-app', text: '<b>x</b>' },
    ]);
    expect(c?.appHtml).toBe(true);
  });

  it('6.5 extracts text from inputRequests in results', () => {
    const segs = extractResultSegments({
      content: [{ type: 'text', text: 'x' }],
      inputRequests: {
        b0: { method: 'elicitation/create', params: { message: 'Enter your password' } },
      },
    });
    expect(segs.map((s) => s.path)).toContain('inputRequests.b0.method');
    expect(segs.map((s) => s.path)).toContain('inputRequests.b0.params.message');
  });

  it('13.1 extracts definition text including schema descriptions', () => {
    const segs = extractDefinitionSegments({
      name: 't',
      description: 'does things',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: 'the query' } },
      },
      annotations: { title: 'T' },
    });
    expect(segs.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        'name',
        'description',
        'inputSchema.properties.q.description',
        'annotations.title',
      ]),
    );
  });

  it('ignores malformed blocks', () => {
    expect(extractContentBlocks('nope')).toEqual([]);
    expect(extractContentBlocks([null, 5, { type: 'text' }])).toEqual([]);
    expect(extractPromptSegments(undefined)).toEqual([]);
    expect(extractResourceContents(undefined)).toEqual([]);
  });
});

describe('scan limits and chunking (13.3)', () => {
  it('13.3 chunks overlap by 200 characters', () => {
    const text = 'a'.repeat(20_000);
    const chunks = chunkText(text, 8000, 200);
    expect(chunks[0]).toEqual({ start: 0, end: 8000 });
    expect(chunks[1]?.start).toBe(7800);
    expect(chunks.at(-1)?.end).toBe(20_000);
  });

  it('13.3 rejects chunk sizes that cannot advance', () => {
    expect(() => chunkText('abc', 200, 200)).toThrow(RangeError);
    expect(chunkText('', 1500, 200)).toEqual([]);
  });

  it('13.3 property: chunks cover the text, overlap, and never split surrogate pairs', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 5000 }),
        fc.integer({ min: 250, max: 900 }),
        (text, size) => {
          const chunks = chunkText(text, size, 200);
          if (text === '') return chunks.length === 0;
          let covered = 0;
          for (const c of chunks) {
            if (c.start > covered) return false;
            covered = Math.max(covered, c.end);
            const first = text.charCodeAt(c.start);
            const last = text.charCodeAt(c.end - 1);
            if (first >= 0xdc00 && first <= 0xdfff && c.start > 0) return false;
            if (last >= 0xd800 && last <= 0xdbff && c.end < text.length) return false;
          }
          return covered === text.length;
        },
      ),
    );
  });

  it('13.3 scanPrefix keeps the first maxScanBytes and preserves segment indices', () => {
    const segs = [
      { path: 'a', text: 'x'.repeat(10) },
      { path: 'b', text: 'y'.repeat(10) },
      { path: 'c', text: 'z'.repeat(10) },
    ];
    const { segments, truncated } = limitSegmentsToBytes(segs, 15);
    expect(truncated).toBe(true);
    expect(segments.map((s) => s.text.length)).toEqual([10, 5, 0]);
    expect(totalTextBytes(segments)).toBeGreaterThanOrEqual(15);
    expect(limitSegmentsToBytes(segs, 100).truncated).toBe(false);
  });

  it('13.3 truncation never leaves half a multibyte character', () => {
    const { segments } = limitSegmentsToBytes([{ path: 'a', text: 'é'.repeat(10) }], 5);
    expect(segments[0]?.text).toBe('éé');
  });

  it('masks segments without shifting indices and keeps their size', () => {
    const masked = maskSegments(
      [
        { path: 'a', text: 'hello' },
        { path: 'b', text: 'x' },
      ],
      (s) => s.path === 'a',
    );
    expect(masked[0]).toMatchObject({ text: '', byteLength: 5 });
    expect(masked[1]?.text).toBe('x');
  });
});

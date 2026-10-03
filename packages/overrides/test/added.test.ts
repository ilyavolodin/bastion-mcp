import { describe, expect, it } from 'vitest';
import {
  addedPromptResult,
  addedResourceContents,
  addedTemplateContents,
  emptyOverrides,
  filterUserLayer,
  mergedAdded,
  parseOverrides,
  previewOverrides,
  type UpstreamPrompt,
  type UpstreamResource,
  withAdded,
} from '../src';

const doc = (added: Record<string, unknown>) => {
  const r = parseOverrides({ version: 1, added });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
};

const prompt = {
  description: 'Review a change',
  arguments: [{ name: 'repo', required: true }, { name: 'focus' }],
  messages: [
    { role: 'user' as const, text: 'Review {{repo}} with focus on {{focus}}.' },
    { role: 'assistant' as const, text: 'Starting with {{repo}}.' },
  ],
};

describe('12.2 added items: the schema', () => {
  it('accepts hosted prompts, resources and templates', () => {
    const d = doc({
      prompts: { review: prompt },
      resources: { 'notes://welcome': { name: 'welcome', text: 'Hello' } },
      resourceTemplates: { 'notes://page/{id}': { name: 'page', text: 'Page {{id}}' } },
    });
    expect(Object.keys(d.added?.prompts ?? {})).toEqual(['review']);
  });

  it('rejects a URI without a scheme, a reserved scheme, an empty message list and oversized text', () => {
    const bad = (added: unknown) => parseOverrides({ version: 1, added }).ok;
    expect(bad({ resources: { welcome: { name: 'w', text: 't' } } })).toBe(false);
    expect(bad({ resources: { 'skill://x': { name: 'w', text: 't' } } })).toBe(false);
    expect(bad({ resources: { 'bastion+a:b://x': { name: 'w', text: 't' } } })).toBe(false);
    expect(bad({ prompts: { p: { messages: [] } } })).toBe(false);
    expect(bad({ prompts: { 'bad name': prompt } })).toBe(false);
    expect(bad({ resources: { 'a://b': { name: 'w', text: 'x'.repeat(100_001) } } })).toBe(false);
    expect(bad({ resources: { 'a://b': { name: 'w', text: 't', extra: 1 } } })).toBe(false);
  });
});

describe('12.2 added items: layers', () => {
  it('the installation layer wins per item over the catalog layer', () => {
    const catalog = doc({
      prompts: { review: prompt, other: { messages: [{ role: 'user', text: 'x' }] } },
    });
    const installation = doc({
      prompts: { review: { messages: [{ role: 'user', text: 'mine' }] } },
    });
    const merged = mergedAdded({ catalog, installation });
    expect(merged.prompts.review?.messages[0]?.text).toBe('mine');
    expect(Object.keys(merged.prompts).sort()).toEqual(['other', 'review']);
  });

  it('only a "full" installation layer may add items (the catalog layer always may)', () => {
    const d = doc({ prompts: { review: prompt } });
    const cosmetic = filterUserLayer(d, 'cosmetic');
    expect(cosmetic.doc.added).toBeUndefined();
    expect(cosmetic.rejected.map((r) => r.path)).toEqual(['/added']);
    expect(filterUserLayer(d, 'none').doc.added).toBeUndefined();
    expect(filterUserLayer(d, 'full').doc.added?.prompts?.review).toBeDefined();
  });
});

describe('12.2 added items: definitions', () => {
  const upstream = {
    prompts: [
      { name: 'review', description: 'upstream review' },
      { name: 'keep' },
    ] as UpstreamPrompt[],
    resources: [{ uri: 'notes://welcome', name: 'upstream' }] as UpstreamResource[],
    resourceTemplates: [],
  };
  const layers = {
    catalog: doc({
      prompts: { review: prompt },
      resources: {
        'notes://welcome': { name: 'welcome', text: 'Hello', mimeType: 'text/markdown' },
      },
      resourceTemplates: { 'notes://page/{id}': { name: 'page', text: 'Page {{id}}' } },
    }),
  };

  it('are listed like upstream definitions and replace an upstream item with the same key', () => {
    const out = withAdded(upstream, layers);
    expect(out.prompts.map((p) => p.name).sort()).toEqual(['keep', 'review']);
    const review = out.prompts.find((p) => p.name === 'review');
    expect(review?.description).toBe('Review a change');
    expect(review?.arguments).toEqual([{ name: 'repo', required: true }, { name: 'focus' }]);
    expect(out.resources).toEqual([
      { uri: 'notes://welcome', name: 'welcome', mimeType: 'text/markdown' },
    ]);
    expect(out.resourceTemplates).toEqual([
      { uriTemplate: 'notes://page/{id}', name: 'page', mimeType: 'text/plain' },
    ]);
  });

  it('leave the input alone when nothing is added', () => {
    expect(withAdded(upstream, { catalog: emptyOverrides() })).toBe(upstream);
  });

  it('show in the preview, hideable like any other item', () => {
    const installation = doc({});
    installation.prompts = { review: { hidden: true } };
    const preview = previewOverrides({}, { ...layers, installation });
    expect(preview.final.hidden).toContainEqual({ kind: 'prompt', key: 'review' });
    expect(preview.final.resources.map((r) => r.resource.uri)).toEqual(['notes://welcome']);
    const shown = previewOverrides({}, layers);
    expect(shown.diff.find((d) => d.key === 'review')).toMatchObject({ added: true });
  });
});

describe('12.2 added items: what is served', () => {
  it('a prompt replaces {{arguments}} and leaves unknown braces alone', () => {
    const out = addedPromptResult(prompt, { repo: 'bastion', focus: 'tests' });
    expect(out).toEqual({
      description: 'Review a change',
      messages: [
        { role: 'user', content: { type: 'text', text: 'Review bastion with focus on tests.' } },
        { role: 'assistant', content: { type: 'text', text: 'Starting with bastion.' } },
      ],
    });
    const open = addedPromptResult(
      { messages: [{ role: 'user', text: 'a {{unknown}} b {x}' }] },
      {},
    );
    expect(open.messages[0]?.content.text).toBe('a {{unknown}} b {x}');
  });

  it('a prompt without a value for a declared argument leaves it empty', () => {
    const out = addedPromptResult(prompt, { repo: 'bastion' });
    expect(out.messages[0]?.content.text).toBe('Review bastion with focus on .');
  });

  it('a resource is its text, with the mime type', () => {
    expect(addedResourceContents('notes://welcome', { name: 'w', text: 'Hello' })).toEqual({
      contents: [{ uri: 'notes://welcome', mimeType: 'text/plain', text: 'Hello' }],
    });
  });

  it('a template matches the URI, fills in its variables, and misses other URIs', () => {
    const def = { name: 'page', text: 'Page {{id}} of {{book}}', mimeType: 'text/markdown' };
    expect(addedTemplateContents('notes://{book}/page/{id}', def, 'notes://guide/page/7')).toEqual({
      contents: [
        { uri: 'notes://guide/page/7', mimeType: 'text/markdown', text: 'Page 7 of guide' },
      ],
    });
    expect(addedTemplateContents('notes://{book}/page/{id}', def, 'notes://guide')).toBeNull();
  });
});

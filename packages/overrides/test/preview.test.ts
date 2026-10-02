import { describe, expect, it } from 'vitest';
import { previewOverrides } from '../src/preview';
import { emptyOverrides, type OverridesDocument } from '../src/schema';

const doc = (partial: Partial<OverridesDocument>): OverridesDocument => ({
  ...emptyOverrides(),
  ...partial,
});

const upstream = {
  instructions: 'Be careful.',
  tools: [
    {
      name: 'create_issue',
      description: 'Creates an issue.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, title: { type: 'string' } },
        required: ['owner'],
      },
    },
    { name: 'delete_issue', inputSchema: { type: 'object' } },
    { name: 'plain', inputSchema: { type: 'object' } },
    {
      name: 'bad_header',
      inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' } } },
    },
  ],
  prompts: [{ name: 'review_pr', description: 'Review' }, { name: 'secret_prompt' }],
  resources: [
    { uri: 'file:///secrets/a', name: 'a' },
    { uri: 'file:///pub/b', name: 'b' },
  ],
  resourceTemplates: [{ uriTemplate: 'repo://{owner}/{repo}', name: 'r' }],
};

describe('17.2 previewOverrides', () => {
  const layers = {
    catalog: doc({ tools: { 'delete_*': { hidden: true } } }),
    installation: doc({
      instructions: { mode: 'append', text: 'Use acme.' },
      tools: {
        create_issue: {
          name: 'gh_new_issue',
          description: { mode: 'append', text: 'Acme only.' },
          pinnedArguments: { owner: 'acme' },
          inputSchemaPatch: [{ op: 'remove', path: '/properties/nope' }],
        },
      },
      prompts: { review_pr: { description: 'Checklist review' }, secret_prompt: { hidden: true } },
      resources: { 'file:///secrets/*': { hidden: true } },
      resourceTemplates: { 'repo://{owner}/{repo}': { pinnedVariables: { owner: 'acme' } } },
    }),
  };
  const result = previewOverrides(upstream, layers);

  it('12.5 returns final definitions per kind and lists hidden and withheld items', () => {
    expect(result.final.tools.map((t) => t.tool.name)).toEqual(['gh_new_issue', 'plain']);
    expect(result.final.prompts.map((p) => p.prompt.name)).toEqual(['review_pr']);
    expect(result.final.resources.map((r) => r.resource.uri)).toEqual(['file:///pub/b']);
    expect(result.final.resourceTemplates[0]?.template.uriTemplate).toBe('repo://acme/{repo}');
    expect(result.final.hidden).toEqual([
      { kind: 'tool', key: 'delete_issue' },
      { kind: 'prompt', key: 'secret_prompt' },
      { kind: 'resource', key: 'file:///secrets/a' },
    ]);
    expect(result.final.invalid).toEqual([
      { kind: 'tool', key: 'bad_header', error: expect.stringContaining('x-mcp-header') },
    ]);
  });

  it('12.5 diff is structured per item with status and JSON Pointer changes', () => {
    const create = result.diff.find((d) => d.key === 'create_issue');
    expect(create?.status).toBe('modified');
    expect(create?.changes).toEqual(
      expect.arrayContaining([
        { path: '/name', op: 'replace', before: 'create_issue', after: 'gh_new_issue' },
        {
          path: '/description',
          op: 'replace',
          before: 'Creates an issue.',
          after: 'Creates an issue.\nAcme only.',
        },
        { path: '/inputSchema/properties/owner', op: 'remove', before: { type: 'string' } },
      ]),
    );
    expect(result.diff.find((d) => d.key === 'plain')).toMatchObject({
      status: 'unchanged',
      changes: [],
    });
    expect(result.diff.find((d) => d.key === 'delete_issue')?.status).toBe('hidden');
    expect(result.diff.find((d) => d.key === 'bad_header')).toMatchObject({
      status: 'invalid',
      error: expect.any(String),
    });
  });

  it('12.5 reports an invalid patch on the item diff and added fields as add ops', () => {
    const create = result.diff.find((d) => d.key === 'create_issue');
    expect(create?.error).toBeDefined();
    const added = previewOverrides(
      { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
      { installation: doc({ tools: { t: { title: 'T' } } }) },
    );
    expect(added.diff[0]?.changes).toEqual([{ path: '/title', op: 'add', after: 'T' }]);
  });

  it('12.3 previews instructions before and after', () => {
    expect(result.instructions).toEqual({ before: 'Be careful.', after: 'Be careful.\nUse acme.' });
    expect(result.final.instructions).toBe('Be careful.\nUse acme.');
    expect(previewOverrides({}, {}).instructions).toBeUndefined();
    expect(
      previewOverrides({}, { installation: doc({ instructions: { mode: 'replace', text: 'x' } }) })
        .instructions,
    ).toEqual({ after: 'x' });
  });

  it('12.3 previews uriPrefix with the given installation slug', () => {
    const r = previewOverrides(
      { resources: [{ uri: 'file:///a', name: 'a' }] },
      { installation: doc({ uriPrefix: true }) },
      { installationSlug: 'fs-a', templateContext: {} },
    );
    expect(r.final.resources[0]?.resource.uri).toBe('bastion+fs-a:file:///a');
  });

  it('12.5 an empty document yields only unchanged items', () => {
    const r = previewOverrides(
      { tools: [{ name: 't', inputSchema: { type: 'object' } }], prompts: [{ name: 'p' }] },
      {},
    );
    expect(r.diff.map((d) => d.status)).toEqual(['unchanged', 'unchanged']);
  });
});

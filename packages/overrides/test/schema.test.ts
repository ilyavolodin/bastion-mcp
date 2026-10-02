import { describe, expect, it } from 'vitest';
import { emptyOverrides, parseOverrides } from '../src/schema';

const spec12_2 = {
  version: 1,
  uriPrefix: false,
  instructions: { mode: 'append', text: 'Use the acme org unless told otherwise.' },
  tools: {
    create_issue: {
      name: 'gh_new_issue',
      title: 'Create GitHub issue',
      description: { mode: 'append', text: 'Issues go to the acme org only.' },
      annotations: { destructiveHint: false },
      pinnedArguments: { owner: 'acme' },
      defaultArguments: { labels: ['from-mcp'] },
      inputSchemaPatch: [
        { op: 'replace', path: '/properties/repo/enum', value: ['web', 'api', 'infra'] },
      ],
      outputTransform: { maxTextBytes: 20000, dropContentTypes: ['image'] },
      meta: { remove: ['internal/debug'] },
      timeoutMs: 120000,
      guardProfileId: null,
    },
    'delete_*': { hidden: true },
  },
  prompts: {
    review_pr: {
      description: "Review a pull request against Acme's checklist",
      arguments: { style: { pinned: 'acme' } },
      messagesTransform: {
        prepend: [{ role: 'user', content: { type: 'text', text: 'Follow docs/review.md.' } }],
      },
    },
  },
  resources: { 'file:///secrets/*': { hidden: true } },
  resourceTemplates: {
    'repo://{owner}/{repo}/contents/{path}': { pinnedVariables: { owner: 'acme' } },
  },
};

describe('12.2 override document schema', () => {
  it('12.2 parses the full example document of the specification', () => {
    const result = parseOverrides(spec12_2);
    expect(result.ok).toBe(true);
  });

  it('12.2 empty object parses to the empty document with defaults', () => {
    const result = parseOverrides({});
    expect(result).toEqual({ ok: true, doc: emptyOverrides() });
  });

  it('12.2 emptyOverrides has version 1 and empty sections', () => {
    expect(emptyOverrides()).toEqual({
      version: 1,
      tools: {},
      prompts: {},
      resources: {},
      resourceTemplates: {},
    });
  });

  it('12.2 rejects unknown fields instead of silently dropping them', () => {
    const result = parseOverrides({ tools: { a: { hidde: true } } });
    expect(result.ok).toBe(false);
  });

  it('12.2 rejects other versions', () => {
    expect(parseOverrides({ version: 2 }).ok).toBe(false);
  });

  it('12.2 rejects invalid JSON Patch operations and pointers', () => {
    expect(
      parseOverrides({ tools: { a: { inputSchemaPatch: [{ op: 'nope', path: '/a' }] } } }).ok,
    ).toBe(false);
    expect(
      parseOverrides({ tools: { a: { inputSchemaPatch: [{ op: 'remove', path: 'no-slash' }] } } })
        .ok,
    ).toBe(false);
  });

  it('7.3 rejects a final name outside the allowed character set', () => {
    expect(parseOverrides({ tools: { a: { name: 'bad name' } } }).ok).toBe(false);
  });

  it('12.2 reports issues with a JSON Pointer path', () => {
    const result = parseOverrides({ tools: { a: { timeoutMs: -1 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('/tools/a/timeoutMs');
  });

  it('12.3 accepts description as a string or a mode object only', () => {
    expect(parseOverrides({ tools: { a: { description: 'x' } } }).ok).toBe(true);
    expect(
      parseOverrides({ tools: { a: { description: { mode: 'prepend', text: 'x' } } } }).ok,
    ).toBe(true);
    expect(parseOverrides({ tools: { a: { description: { mode: 'weird', text: 'x' } } } }).ok).toBe(
      false,
    );
  });
});

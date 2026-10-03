import { describe, expect, it } from 'vitest';
import {
  ADDED_LIMITS,
  emptyOverrides,
  overrideJsonSchema,
  sectionOf,
  setAddedItem,
  setItemField,
  validateOverrideText,
} from './override-schema';

const issuesOf = (doc: unknown) => {
  const r = validateOverrideText(JSON.stringify(doc));
  return r.ok ? [] : r.issues;
};

describe('validateOverrideText (12.2)', () => {
  it('accepts an empty text, {} and a document without a version as the empty document', () => {
    expect(validateOverrideText('')).toEqual({ ok: true, document: { version: 1 }, issues: [] });
    expect(validateOverrideText('   \n')).toMatchObject({ ok: true, document: { version: 1 } });
    expect(validateOverrideText('{}')).toMatchObject({ ok: true, document: { version: 1 } });
  });

  it('reports a syntax error with no path', () => {
    const r = validateOverrideText('{ "tools": ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual([{ path: '', message: expect.any(String) }]);
  });

  it('rejects unknown keys and a version other than 1', () => {
    expect(issuesOf({ tols: {} }).length).toBeGreaterThan(0);
    expect(issuesOf({ version: 2 }).length).toBeGreaterThan(0);
  });

  it('checks tool names, descriptions and patch operations with a dotted path to the problem', () => {
    expect(issuesOf({ tools: { t: { name: 'bad name!' } } })[0]).toMatchObject({
      path: 'tools.t.name',
    });
    expect(issuesOf({ tools: { t: { description: { mode: 'append', text: 'more' } } } })).toEqual(
      [],
    );
    expect(
      issuesOf({ tools: { t: { inputSchemaPatch: [{ op: 'remove', path: 'no-slash' }] } } })[0]
        ?.path,
    ).toContain('inputSchemaPatch');
    expect(
      issuesOf({
        tools: { t: { inputSchemaPatch: [{ op: 'add', path: '/properties/x', value: { a: 1 } }] } },
      }),
    ).toEqual([]);
  });

  it('checks the items Bastion hosts: names, schemes and the reserved ones', () => {
    const ok = {
      added: {
        prompts: { greet: { messages: [{ role: 'user', text: 'hi' }] } },
        resources: { 'notes://welcome': { name: 'Welcome', text: 'hello' } },
      },
    };
    expect(issuesOf(ok)).toEqual([]);
    expect(
      issuesOf({
        added: { prompts: { 'bad name': { messages: [{ role: 'user', text: 'x' }] } } },
      })[0]?.path,
    ).toBe('added.prompts.bad name');
    const noScheme = issuesOf({ added: { resources: { welcome: { name: 'W', text: 't' } } } });
    expect(noScheme[0]?.message).toContain('scheme');
    const reserved = issuesOf({ added: { resources: { 'skill://x': { name: 'W', text: 't' } } } });
    expect(reserved[0]?.message).toBe('this scheme is reserved by Bastion');
  });

  it('limits what a hosted prompt says', () => {
    const tooMany = Array.from({ length: ADDED_LIMITS.messages + 1 }, () => ({
      role: 'user',
      text: 'x',
    }));
    expect(issuesOf({ added: { prompts: { p: { messages: tooMany } } } }).length).toBeGreaterThan(
      0,
    );
    expect(issuesOf({ added: { prompts: { p: { messages: [] } } } }).length).toBeGreaterThan(0);
  });
});

describe('document edits', () => {
  it('setItemField sets a field, clears it with an empty value, and drops empty items and sections', () => {
    const a = setItemField(emptyOverrides(), 'tools', 't', 'title', 'Title');
    expect(a).toEqual({ version: 1, tools: { t: { title: 'Title' } } });
    const b = setItemField(a, 'tools', 't', 'hidden', true);
    expect(b.tools?.t).toEqual({ title: 'Title', hidden: true });
    expect(setItemField(b, 'tools', 't', 'title', '').tools?.t).toEqual({ hidden: true });
    expect(setItemField(a, 'tools', 't', 'title', null)).toEqual({ version: 1 });
    expect(setItemField(a, 'tools', 't', 'title', undefined)).toEqual({ version: 1 });
  });

  it('setItemField does not change the document it was given', () => {
    const doc = { version: 1 as const, tools: { t: { title: 'A' } } };
    setItemField(doc, 'tools', 't', 'title', 'B');
    expect(doc).toEqual({ version: 1, tools: { t: { title: 'A' } } });
  });

  it('setAddedItem adds, replaces and removes; empty sections and `added` disappear', () => {
    const a = setAddedItem(emptyOverrides(), 'prompts', 'p', { messages: [] });
    expect(a.added).toEqual({ prompts: { p: { messages: [] } } });
    const b = setAddedItem(a, 'resources', 'notes://a', { name: 'A', text: '' });
    expect(Object.keys(b.added ?? {})).toEqual(['prompts', 'resources']);
    expect(setAddedItem(b, 'resources', 'notes://a', undefined).added).toEqual({
      prompts: { p: { messages: [] } },
    });
    expect(setAddedItem(a, 'prompts', 'p', undefined)).toEqual({ version: 1 });
  });

  it('sectionOf maps an item kind to its section of the document', () => {
    expect(sectionOf('tool')).toBe('tools');
    expect(sectionOf('prompt')).toBe('prompts');
    expect(sectionOf('resource')).toBe('resources');
    expect(sectionOf('template')).toBe('resourceTemplates');
  });

  it('overrideJsonSchema describes the document for the editor', () => {
    const schema = overrideJsonSchema();
    expect(schema.type).toBe('object');
    expect(Object.keys((schema.properties ?? {}) as object)).toEqual(
      expect.arrayContaining(['tools', 'prompts', 'resources', 'resourceTemplates', 'added']),
    );
  });
});

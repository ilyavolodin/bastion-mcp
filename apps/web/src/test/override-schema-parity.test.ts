/**
 * `lib/override-schema.ts` is a deliberate copy of `packages/overrides/src/schema.ts` (web may not import the package,
 * 5.3). This test loads the package schema by path and parses one corpus with both, so that drift in what is accepted
 * fails here. The known, intended differences are pinned as such.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateOverrideText } from '@/lib/override-schema';

type Parse = (input: unknown) => { ok: boolean };
let parseOverrides: Parse;

beforeAll(async () => {
  const file = resolve(import.meta.dirname, '../../../../packages/overrides/src/schema.ts');
  const mod: unknown = await import(/* @vite-ignore */ pathToFileURL(file).href);
  parseOverrides = (mod as { parseOverrides: Parse }).parseOverrides;
});

const webAccepts = (doc: unknown) => validateOverrideText(JSON.stringify(doc)).ok;

const msg = [{ role: 'user', text: 'x' }];
const bothAccept: Record<string, unknown> = {
  minimal: { version: 1 },
  tool: {
    version: 1,
    tools: {
      t: {
        name: 'renamed',
        title: 'T',
        description: { mode: 'append', text: 'more' },
        hidden: true,
        annotations: { readOnlyHint: true },
      },
    },
  },
  instructions: { version: 1, uriPrefix: true, instructions: { mode: 'replace', text: 'hi' } },
  patch: {
    version: 1,
    tools: {
      t: {
        inputSchemaPatch: [
          { op: 'add', path: '/a', value: 1 },
          { op: 'replace', path: '/a', value: [1] },
          { op: 'test', path: '/a', value: null },
          { op: 'remove', path: '/a' },
          { op: 'move', from: '/a', path: '/b' },
          { op: 'copy', from: '/a', path: '/b' },
        ],
      },
    },
  },
  prompt: {
    version: 1,
    prompts: { p: { title: 'P', arguments: { a: { pinned: 'x' } }, hidden: true } },
  },
  resource: { version: 1, resources: { 'file:///a': { title: 'R' } } },
  template: { version: 1, resourceTemplates: { 'x://{a}': { hidden: true } } },
  added: {
    version: 1,
    added: {
      prompts: { greet: { messages: msg } },
      resources: { 'notes://welcome': { name: 'welcome', text: 'hi' } },
      resourceTemplates: { 'notes://{id}': { name: 'note', text: 'n {{id}}' } },
    },
  },
};

const bothReject: Record<string, unknown> = {
  version2: { version: 2 },
  unknownKey: { version: 1, tols: {} },
  badToolName: { version: 1, tools: { t: { name: 'bad name!' } } },
  badPointer: {
    version: 1,
    tools: { t: { inputSchemaPatch: [{ op: 'add', path: 'a', value: 1 }] } },
  },
  badOp: { version: 1, tools: { t: { inputSchemaPatch: [{ op: 'nope', path: '/a' }] } } },
  badMode: { version: 1, tools: { t: { description: { mode: 'x', text: 'y' } } } },
  addedBadPromptKey: { version: 1, added: { prompts: { 'bad key': { messages: msg } } } },
  addedNoScheme: { version: 1, added: { resources: { nope: { name: 'n', text: 't' } } } },
  addedReserved: { version: 1, added: { resources: { 'skill://x': { name: 'n', text: 't' } } } },
  addedNoMessages: { version: 1, added: { prompts: { p: { messages: [] } } } },
  addedTooMany: {
    version: 1,
    added: { prompts: { p: { messages: Array.from({ length: 21 }, () => msg[0]) } } },
  },
  addedTooLong: {
    version: 1,
    added: { resources: { 'a://b': { name: 'n', text: 'x'.repeat(100_001) } } },
  },
};

describe('override schema parity: web copy vs packages/overrides', () => {
  for (const [name, doc] of Object.entries(bothAccept)) {
    it(`12.2 both accept ${name}`, () => {
      expect(parseOverrides(doc).ok).toBe(true);
      expect(webAccepts(doc)).toBe(true);
    });
  }
  for (const [name, doc] of Object.entries(bothReject)) {
    it(`12.2 both reject ${name}`, () => {
      expect(parseOverrides(doc).ok).toBe(false);
      expect(webAccepts(doc)).toBe(false);
    });
  }

  it('12.2 intended difference: an empty record key is refused by the package and accepted by the editor copy', () => {
    const doc = { version: 1, tools: { '': { hidden: true } } };
    expect(parseOverrides(doc).ok).toBe(false);
    expect(webAccepts(doc)).toBe(true);
  });
});

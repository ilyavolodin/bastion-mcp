import { describe, expect, it } from 'vitest';
import { filterUserLayer } from '../src/permissions';
import { emptyOverrides, type OverridesDocument } from '../src/schema';

const full: OverridesDocument = {
  ...emptyOverrides(),
  uriPrefix: true,
  instructions: { mode: 'append', text: 'hi' },
  tools: {
    t: {
      name: 'x',
      title: 'T',
      description: 'D',
      hidden: true,
      pinnedArguments: { a: 1 },
      defaultArguments: { b: 2 },
      inputSchemaPatch: [{ op: 'remove', path: '/properties/c' }],
      outputTransform: { maxTextBytes: 5 },
      meta: { remove: ['k'] },
      timeoutMs: 100,
      annotations: { idempotentHint: true },
    },
  },
  prompts: {
    p: {
      name: 'pp',
      description: 'd',
      hidden: true,
      arguments: { a: { pinned: 'x' } },
      messagesTransform: { prepend: [] },
    },
  },
  resources: { 'file:///a': { hidden: true, title: 't' } },
  resourceTemplates: { 'r://{a}': { hidden: true, pinnedVariables: { a: '1' }, description: 'd' } },
};

describe('12.1 userOverrides permissions', () => {
  it('12.1 level none strips everything and reports each rejection', () => {
    const { doc, rejected } = filterUserLayer(full, 'none');
    expect(doc).toEqual(emptyOverrides());
    expect(rejected.length).toBeGreaterThan(10);
    expect(rejected.every((r) => r.path.startsWith('/') && r.reason.length > 0)).toBe(true);
  });

  it('12.1 cosmetic keeps hide, name, title, description only', () => {
    const { doc, rejected } = filterUserLayer(full, 'cosmetic');
    expect(doc.tools.t).toEqual({ name: 'x', title: 'T', description: 'D', hidden: true });
    expect(doc.prompts.p).toEqual({ name: 'pp', description: 'd', hidden: true });
    expect(doc.resources['file:///a']).toEqual({ hidden: true, title: 't' });
    expect(doc.resourceTemplates['r://{a}']).toEqual({ hidden: true, description: 'd' });
    const paths = rejected.map((r) => r.path);
    expect(paths).toContain('/tools/t/pinnedArguments');
    expect(paths).toContain('/tools/t/inputSchemaPatch');
    expect(paths).toContain('/tools/t/outputTransform');
    expect(paths).toContain('/prompts/p/arguments');
    expect(paths).toContain('/resourceTemplates/r:~1~1{a}/pinnedVariables');
    expect(paths).toContain('/uriPrefix');
  });

  it('12.1 cosmetic keeps instructions', () => {
    expect(filterUserLayer(full, 'cosmetic').doc.instructions).toEqual(full.instructions);
  });

  it('12.1 full also allows arguments, schema patches, output transforms and uriPrefix', () => {
    const { doc, rejected } = filterUserLayer(full, 'full');
    expect(doc.tools.t?.pinnedArguments).toEqual({ a: 1 });
    expect(doc.tools.t?.inputSchemaPatch).toHaveLength(1);
    expect(doc.tools.t?.outputTransform).toEqual({ maxTextBytes: 5 });
    expect(doc.tools.t?.annotations).toEqual({ idempotentHint: true });
    expect(doc.prompts.p?.arguments).toEqual({ a: { pinned: 'x' } });
    expect(doc.resourceTemplates['r://{a}']?.pinnedVariables).toEqual({ a: '1' });
    expect(doc.uriPrefix).toBe(true);
    expect(rejected).toEqual([]);
  });

  it.each([
    ['readOnlyHint', true],
    ['destructiveHint', false],
    ['openWorldHint', false],
  ] as const)('12.1 %s=%s (looks safer) is catalog-only even at level full', (hint, value) => {
    const input: OverridesDocument = {
      ...emptyOverrides(),
      tools: { t: { annotations: { [hint]: value, idempotentHint: true } } },
    };
    const { doc, rejected } = filterUserLayer(input, 'full');
    expect(doc.tools.t?.annotations).toEqual({ idempotentHint: true });
    expect(rejected).toEqual([
      { path: `/tools/t/annotations/${hint}`, reason: expect.stringContaining('catalog layer') },
    ]);
  });

  it('12.1 annotation changes that make a tool look more dangerous are allowed at full', () => {
    const input: OverridesDocument = {
      ...emptyOverrides(),
      tools: {
        t: { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      },
    };
    expect(filterUserLayer(input, 'full').rejected).toEqual([]);
  });

  it('12.1 an entry whose only annotations are rejected loses the annotations key', () => {
    const input: OverridesDocument = {
      ...emptyOverrides(),
      tools: { t: { annotations: { readOnlyHint: true }, title: 'x' } },
    };
    expect(filterUserLayer(input, 'full').doc.tools.t).toEqual({ title: 'x' });
  });

  it('12.1 guardProfileId is never settable in the installation layer', () => {
    const input: OverridesDocument = {
      ...emptyOverrides(),
      tools: { t: { guardProfileId: null } },
    };
    const { doc, rejected } = filterUserLayer(input, 'full');
    expect(doc.tools).toEqual({});
    expect(rejected[0]?.path).toBe('/tools/t/guardProfileId');
  });

  it('12.1 hidden: false cannot undo a catalog-layer hide', () => {
    const input: OverridesDocument = { ...emptyOverrides(), tools: { t: { hidden: false } } };
    const { doc, rejected } = filterUserLayer(input, 'full');
    expect(doc.tools).toEqual({});
    expect(rejected[0]?.path).toBe('/tools/t/hidden');
  });

  it('12.1 the catalog layer is not filtered (filterUserLayer is not applied to it); input is not mutated', () => {
    const before = structuredClone(full);
    filterUserLayer(full, 'none');
    expect(full).toEqual(before);
  });
});

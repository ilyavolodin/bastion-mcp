import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  mergeLayers,
  mergePromptOverride,
  mergeResourceOverride,
  mergeResourceTemplateOverride,
  mergeToolOverride,
} from '../src/merge';
import { resolveToolOverride } from '../src/resolve';
import { emptyOverrides, type OverridesDocument, type ToolOverride } from '../src/schema';

const doc = (partial: Partial<OverridesDocument>): OverridesDocument => ({
  ...emptyOverrides(),
  ...partial,
});

describe('12.3 merging layers', () => {
  it('12.3 installation overrides catalog field by field', () => {
    const catalog = doc({ tools: { t: { title: 'cat', description: 'cat desc', hidden: true } } });
    const installation = doc({ tools: { t: { title: 'inst' } } });
    expect(mergeLayers(catalog, installation).tools.t).toEqual({
      title: 'inst',
      description: 'cat desc',
      hidden: true,
    });
  });

  it('12.3 inputSchemaPatch lists concatenate, catalog first', () => {
    const a = { op: 'remove', path: '/a' } as const;
    const b = { op: 'remove', path: '/b' } as const;
    const merged = mergeLayers(
      doc({ tools: { t: { inputSchemaPatch: [a] } } }),
      doc({ tools: { t: { inputSchemaPatch: [b] } } }),
    );
    expect(merged.tools.t?.inputSchemaPatch).toEqual([a, b]);
  });

  it('12.3 records merge key by key with the installation winning on conflicts', () => {
    const merged = mergeLayers(
      doc({
        tools: {
          t: { pinnedArguments: { a: 1, b: 2 }, annotations: { title: 'x', idempotentHint: true } },
        },
      }),
      doc({ tools: { t: { pinnedArguments: { b: 3 }, annotations: { title: 'y' } } } }),
    );
    expect(merged.tools.t?.pinnedArguments).toEqual({ a: 1, b: 3 });
    expect(merged.tools.t?.annotations).toEqual({ title: 'y', idempotentHint: true });
  });

  it('12.3 meta set merges and remove lists concatenate; outputTransform merges per field', () => {
    const merged = mergeToolOverride(
      {
        meta: { set: { a: 1 }, remove: ['x'] },
        outputTransform: { maxTextBytes: 10, dropContentTypes: ['image'] },
      },
      { meta: { set: { b: 2 }, remove: ['y'] }, outputTransform: { maxTextBytes: 20 } },
    );
    expect(merged.meta).toEqual({ set: { a: 1, b: 2 }, remove: ['x', 'y'] });
    expect(merged.outputTransform).toEqual({ maxTextBytes: 20, dropContentTypes: ['image'] });
  });

  it('12.3 a defined false or null in the installation overrides the catalog', () => {
    const merged = mergeToolOverride(
      { hidden: true, guardProfileId: 'g' },
      { hidden: false, guardProfileId: null },
    );
    expect(merged).toEqual({ hidden: false, guardProfileId: null });
  });

  it('12.3 merges prompts, resources and templates field by field', () => {
    expect(
      mergePromptOverride(
        { arguments: { a: { pinned: 'x' } }, messagesTransform: { prepend: [] }, name: 'n' },
        {
          arguments: { a: { hidden: true }, b: { pinned: 'y' } },
          messagesTransform: { append: [] },
        },
      ),
    ).toEqual({
      name: 'n',
      arguments: { a: { pinned: 'x', hidden: true }, b: { pinned: 'y' } },
      messagesTransform: { prepend: [], append: [] },
    });
    expect(mergeResourceOverride({ title: 'a', hidden: true }, { title: 'b' })).toEqual({
      title: 'b',
      hidden: true,
    });
    expect(
      mergeResourceTemplateOverride(
        { pinnedVariables: { a: '1' } },
        { pinnedVariables: { b: '2' }, hidden: true },
      ),
    ).toEqual({ pinnedVariables: { a: '1', b: '2' }, hidden: true });
  });

  it('12.3 uriPrefix and instructions: installation wins when set', () => {
    const merged = mergeLayers(
      doc({ uriPrefix: true, instructions: { mode: 'append', text: 'a' } }),
      doc({ instructions: { mode: 'replace', text: 'b' } }),
    );
    expect(merged.uriPrefix).toBe(true);
    expect(merged.instructions).toEqual({ mode: 'replace', text: 'b' });
  });

  it('12.3 does not modify its inputs', () => {
    const catalog = doc({ tools: { t: { pinnedArguments: { a: 1 } } } });
    const installation = doc({ tools: { t: { pinnedArguments: { b: 2 } } } });
    const before = structuredClone([catalog, installation]);
    mergeLayers(catalog, installation);
    expect([catalog, installation]).toEqual(before);
  });
});

const NAMES = ['a', 'b', 'c'];
const jsonArb = fc.oneof(fc.string(), fc.integer(), fc.boolean());
const toolArb: fc.Arbitrary<ToolOverride> = fc.record(
  {
    name: fc.constantFrom('n1', 'n2'),
    title: fc.string(),
    description: fc.oneof(
      fc.string(),
      fc.record({
        mode: fc.constantFrom('append', 'prepend', 'replace' as const),
        text: fc.string(),
      }),
    ),
    annotations: fc.record(
      { title: fc.string(), readOnlyHint: fc.boolean() },
      { requiredKeys: [] },
    ),
    pinnedArguments: fc.dictionary(fc.constantFrom('p', 'q', 'r'), jsonArb),
    defaultArguments: fc.dictionary(fc.constantFrom('p', 'q', 'r'), jsonArb),
    inputSchemaPatch: fc.array(
      fc.record({ op: fc.constant('remove' as const), path: fc.constantFrom('/a', '/b', '/c') }),
      { maxLength: 3 },
    ),
    outputTransform: fc.record(
      {
        maxTextBytes: fc.integer({ min: 1, max: 100 }),
        dropContentTypes: fc.array(fc.constantFrom('image', 'audio')),
      },
      { requiredKeys: [] },
    ),
    meta: fc.record(
      {
        set: fc.dictionary(fc.constantFrom('k', 'l'), jsonArb),
        remove: fc.array(fc.constantFrom('x', 'y')),
      },
      { requiredKeys: [] },
    ),
    timeoutMs: fc.integer({ min: 1, max: 1000 }),
    guardProfileId: fc.oneof(fc.constant(null), fc.constantFrom('g1', 'g2')),
    hidden: fc.boolean(),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<ToolOverride>;

const docArb: fc.Arbitrary<OverridesDocument> = fc
  .record(
    {
      tools: fc.dictionary(fc.constantFrom(...NAMES), toolArb),
      uriPrefix: fc.boolean(),
      instructions: fc.record({
        mode: fc.constantFrom('append', 'replace' as const),
        text: fc.string(),
      }),
    },
    { requiredKeys: ['tools'] },
  )
  .map((r) => ({ ...emptyOverrides(), ...r }) as OverridesDocument);

describe('23.1 override merge laws (property)', () => {
  it('23.1 merge with the empty document is identity on both sides', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        expect(mergeLayers(d, emptyOverrides())).toEqual(d);
        expect(mergeLayers(emptyOverrides(), d)).toEqual(d);
      }),
    );
  });

  it('23.1 merge is associative', () => {
    fc.assert(
      fc.property(docArb, docArb, docArb, (a, b, c) => {
        expect(mergeLayers(mergeLayers(a, b), c)).toEqual(mergeLayers(a, mergeLayers(b, c)));
      }),
    );
  });

  it('23.1 resolving merge(a, b) equals merging the resolved items (exact keys)', () => {
    fc.assert(
      fc.property(docArb, docArb, fc.constantFrom(...NAMES), (a, b, name) => {
        const viaDoc = resolveToolOverride({ installation: mergeLayers(a, b) }, name);
        const viaLayers = resolveToolOverride({ catalog: a, installation: b }, name);
        expect(viaDoc).toEqual(viaLayers);
      }),
    );
  });

  it('23.1 field-level overrides: the later layer wins for every scalar field it sets', () => {
    fc.assert(
      fc.property(toolArb, toolArb, (a, b) => {
        const m = mergeToolOverride(a, b);
        for (const key of [
          'name',
          'title',
          'description',
          'timeoutMs',
          'guardProfileId',
          'hidden',
        ] as const) {
          expect(m[key]).toEqual(b[key] !== undefined ? b[key] : a[key]);
        }
      }),
    );
  });
});

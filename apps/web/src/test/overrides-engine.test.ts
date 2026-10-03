/**
 * The mock's override engine (`mocks/servers/overrides-engine.ts`) is a stand-in for `@bastion-mcp/overrides`. These
 * tests pin its merge semantics and compare them with the real package, so the mock cannot drift from what the
 * server serves: the installation layer wins field by field, a text override is applied once, globs match.
 */
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { definitionsFor, previewFor, toUpstream } from '@/mocks/servers/overrides-engine';

type Json = Record<string, unknown>;
type OverridesDocument = Json;
type UpstreamTool = {
  name: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
} & Json;
type RealResult = { kind: string; tool?: UpstreamTool };
type RealApply = {
  applyToTool: (
    tool: UpstreamTool,
    layers: { catalog?: OverridesDocument; installation?: OverridesDocument },
  ) => RealResult;
};

// The real package is loaded by path, not through the web app's imports: it is another package (its own strictness)
// and nothing of the app depends on it. Only this test compares the mock with it.
let real: RealApply;
beforeAll(async () => {
  const file = resolve(import.meta.dirname, '../../../../packages/overrides/src/apply.ts');
  real = (await import(/* @vite-ignore */ file.replaceAll('\\', '/'))) as RealApply;
});

const upstreamTool = (name: string, description = 'Runs a query.'): UpstreamTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  annotations: { readOnlyHint: false, destructiveHint: true },
});

const doc = (tools: Json, extra: Json = {}): OverridesDocument =>
  ({ version: 1, tools, prompts: {}, resources: {}, resourceTemplates: {}, ...extra }) as never;

const mockTools = (
  tools: UpstreamTool[],
  catalog: OverridesDocument | undefined,
  installation: OverridesDocument | undefined,
) =>
  definitionsFor(
    'tool',
    { tools: tools as Json[], prompts: [], resources: [], resourceTemplates: [] },
    [catalog as Json | undefined, installation as Json | undefined],
    null,
  );

/** What the real package serves for the same layers (`undefined` when the tool is hidden). */
const realTool = (
  tool: UpstreamTool,
  catalog: OverridesDocument | undefined,
  installation: OverridesDocument | undefined,
) => {
  const out = real.applyToTool(tool, { catalog, installation });
  return out.kind === 'tool' ? out.tool : undefined;
};

const CASES: { name: string; catalog?: OverridesDocument; installation?: OverridesDocument }[] = [
  { name: 'no overrides' },
  { name: 'catalog title', catalog: doc({ pg_run: { title: 'Run' } }) },
  {
    name: 'installation title over catalog title',
    catalog: doc({ pg_run: { title: 'Run' } }),
    installation: doc({ pg_run: { title: 'Run it' } }),
  },
  {
    name: 'append in both layers: the installation text replaces the catalog one, applied once',
    catalog: doc({ pg_run: { description: { mode: 'append', text: 'Catalog note.' } } }),
    installation: doc({ pg_run: { description: { mode: 'append', text: 'My note.' } } }),
  },
  {
    name: 'prepend and a plain replacement',
    catalog: doc({ pg_run: { description: { mode: 'prepend', text: 'First.' } } }),
    installation: doc({ pg_run: { description: 'Replaced.' } }),
  },
  {
    name: 'annotations merge hint by hint',
    catalog: doc({ pg_run: { annotations: { readOnlyHint: true } } }),
    installation: doc({ pg_run: { annotations: { destructiveHint: false } } }),
  },
  {
    name: 'rename',
    catalog: doc({ pg_run: { name: 'run_sql' } }),
  },
  {
    name: 'a glob applies, the exact key on top of it',
    catalog: doc({ 'pg_*': { title: 'Postgres' }, pg_run: { description: 'Exact.' } }),
  },
  {
    name: 'a longer glob wins over a shorter one',
    catalog: doc({ '*': { title: 'Any' }, 'pg_r*': { title: 'Runs' } }),
  },
];

describe('the mock override engine serves what the real package serves (12.3)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const tool = upstreamTool('pg_run');
      const mock = mockTools([tool], c.catalog, c.installation).items[0];
      const real = realTool(tool, c.catalog, c.installation);
      expect(mock).toEqual(
        real && {
          name: real.name,
          description: real.description,
          inputSchema: real.inputSchema,
          annotations: real.annotations,
          ...(real.title === undefined ? {} : { title: real.title }),
        },
      );
    });
  }

  it('hidden: the installation layer can show again what the catalog hid (the later layer wins)', () => {
    const tool = upstreamTool('pg_run');
    const catalog = doc({ pg_run: { hidden: true } });
    const installation = doc({ pg_run: { hidden: false } });
    expect(realTool(tool, catalog, installation)).toBeDefined();
    expect(mockTools([tool], catalog, installation).items).toHaveLength(1);
    expect(realTool(tool, catalog, undefined)).toBeUndefined();
    expect(mockTools([tool], catalog, undefined).items).toHaveLength(0);
  });

  it('hidden in the installation layer hides what the catalog showed', () => {
    const tool = upstreamTool('pg_run');
    const installation = doc({ pg_run: { hidden: true } });
    expect(realTool(tool, undefined, installation)).toBeUndefined();
    expect(mockTools([tool], undefined, installation).items).toEqual([]);
  });
});

describe('the mock override engine, on its own', () => {
  const upstream = toUpstream([
    { kind: 'tool', name: 'a', description: 'A.', access: 'read' },
    { kind: 'tool', name: 'b', description: 'B.', access: 'write' },
  ]);

  it('meta tells what changed: overridden and renamed', () => {
    const out = definitionsFor(
      'tool',
      upstream,
      [doc({ a: { name: 'alpha' }, b: { title: 'Bee' } }) as Json],
      null,
    );
    expect(out.meta.map((m) => [m.upstreamKey, m.finalKey, m.overridden, m.renamed])).toEqual([
      ['a', 'alpha', true, true],
      ['b', 'b', true, false],
    ]);
  });

  it('the preview lists hidden items and the changes of the others', () => {
    const preview = previewFor(
      upstream,
      undefined,
      doc({ a: { hidden: true }, b: { title: 'Bee' } }),
    );
    expect(preview.final.hidden).toEqual([{ kind: 'tool', key: 'a' }]);
    expect(preview.diff.find((d) => d.key === 'b')).toMatchObject({
      status: 'modified',
      changes: [{ path: '/title', op: 'add', after: 'Bee' }],
    });
  });

  it('items written in the document (added) are served like upstream ones; a later layer wins per key', () => {
    const catalog = { version: 1, added: { prompts: { hello: { description: 'Hi.' } } } } as Json;
    const installation = {
      version: 1,
      added: { prompts: { hello: { description: 'Hello.' } } },
    } as Json;
    const out = definitionsFor('prompt', upstream, [catalog, installation], null);
    expect(out.items).toEqual([{ name: 'hello', description: 'Hello.' }]);
  });
});

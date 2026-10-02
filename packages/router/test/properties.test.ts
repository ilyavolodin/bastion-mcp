import { NAME_PATTERN, type NameCandidate, resolveNames } from '@bastion-mcp/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileEndpoint, serializeEndpoint, type UpstreamItemSource } from '../src';
import { engineFor, installation, items, principal, requestContext, tool } from './helpers';

const upstreamName = fc.string({ minLength: 1, maxLength: 200 });

describe('23.1 property: name sanitization and collision resolution (7.3)', () => {
  const candidates = fc.array(
    fc.record({
      inst: fc.integer({ min: 0, max: 3 }),
      name: upstreamName,
      exact: fc.option(fc.stringMatching(/^[A-Za-z0-9_.-]{1,40}$/), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 25 },
  );
  const toCandidates = (list: Array<{ inst: number; name: string; exact?: string | undefined }>) =>
    list.map((c, i): NameCandidate => {
      const out: NameCandidate = {
        key: String(i),
        installationId: `i${c.inst}`,
        priority: c.inst,
        prefix: `p${c.inst}`,
        upstreamName: c.name,
      };
      if (c.exact !== undefined) out.exactName = c.exact;
      return out;
    });

  it('7.3 every final name matches ^[A-Za-z0-9_.-]{1,128}$ and is unique, in both modes', () => {
    fc.assert(
      fc.property(candidates, fc.constantFrom('always', 'onCollision' as const), (list, mode) => {
        const names = resolveNames(toCandidates(list), mode).map((r) => r.name);
        for (const n of names) expect(NAME_PATTERN.test(n)).toBe(true);
        expect(new Set(names).size).toBe(names.length);
      }),
    );
  });

  it('7.3 the higher-priority installation keeps a contested name', () => {
    fc.assert(
      fc.property(upstreamName, (name) => {
        const r = resolveNames(
          [
            {
              key: 'b',
              installationId: 'b',
              priority: 1,
              prefix: 'x',
              upstreamName: name,
              exactName: 'same',
            },
            {
              key: 'a',
              installationId: 'a',
              priority: 0,
              prefix: 'x',
              upstreamName: name,
              exactName: 'same',
            },
          ],
          'always',
        );
        expect(r[1]?.name).toBe('same');
        expect(r[0]?.name).toBe('same_2');
      }),
    );
  });
});

describe('6.7 property: compile determinism', () => {
  const toolNames = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/), {
    minLength: 0,
    maxLength: 12,
  });
  const spec = fc.array(toolNames, { minLength: 1, maxLength: 5 });

  it('6.7 same inputs give byte-identical, sorted output regardless of input order (default endpoint)', async () => {
    await fc.assert(
      fc.asyncProperty(spec, fc.boolean(), async (lists, onCollision) => {
        const insts = lists.map((_, i) =>
          installation({ id: `i${i}`, slug: `s${i}`, displayName: `D${i}` }),
        );
        const map = Object.fromEntries(
          lists.map((names, i) => [`i${i}`, items({ tools: names.map((n) => tool(n)) })]),
        );
        const source: UpstreamItemSource = {
          listItems: async (inst) => ({
            status: 'ok',
            items: map[inst.id] ?? items(),
            origin: 'cache',
          }),
        };
        const run = async (list: typeof insts, toolOrder: boolean) => {
          const src: UpstreamItemSource = toolOrder
            ? {
                listItems: async (inst) => {
                  const it = map[inst.id] ?? items();
                  return {
                    status: 'ok',
                    items: { ...it, tools: [...it.tools].reverse() },
                    origin: 'cache',
                  };
                },
              }
            : source;
          return compileEndpoint({
            principal,
            endpoint: {
              id: 'default',
              kind: 'default',
              prefixMode: onCollision ? 'onCollision' : 'always',
            },
            installations: list,
            source: src,
            policy: engineFor(insts),
            requestContext,
            org: { displayName: 'Acme' },
            serverVersion: '1',
            configVersion: '1',
          });
        };
        const a = await run(insts, false);
        const b = await run([...insts].reverse(), false);
        expect(serializeEndpoint(a)).toBe(serializeEndpoint(b));
        const sorted = [...a.tools.map((t) => t.name)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        expect(a.tools.map((t) => t.name)).toEqual(sorted);
        expect(new Set(sorted).size).toBe(sorted.length);
        expect(a.hash).toBe(b.hash);
      }),
      { numRuns: 40 },
    );
  });
});

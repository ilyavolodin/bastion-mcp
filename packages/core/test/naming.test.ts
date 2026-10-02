import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  finalName,
  MAX_NAME_LENGTH,
  NAME_PATTERN,
  resolveNames,
  sanitizeNamePart,
  sha256Hex,
} from '../src/naming';

describe('7.3 naming tools and prompts', () => {
  it('joins prefix and upstream name with a double underscore', () => {
    expect(finalName('github', 'create_issue')).toBe('github__create_issue');
  });

  it('replaces characters outside [A-Za-z0-9_.-] with _', () => {
    expect(sanitizeNamePart('a b/c:d')).toBe('a_b_c_d');
    expect(sanitizeNamePart('ok.name-1_x')).toBe('ok.name-1_x');
  });

  it('cuts names longer than 128 chars and appends _ plus the first 6 hex of the upstream SHA-256', () => {
    const upstream = 'x'.repeat(200);
    const name = finalName('gh', upstream);
    expect(name).toHaveLength(MAX_NAME_LENGTH);
    expect(name.endsWith(`_${sha256Hex(upstream).slice(0, 6)}`)).toBe(true);
    expect(name.startsWith('gh__x')).toBe(true);
  });

  it('property: final names always match the pattern and fit the limit', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9_]{1,20}$/),
        fc.string({ minLength: 1, maxLength: 300 }),
        (prefix, upstream) => {
          const name = finalName(prefix, upstream);
          return NAME_PATTERN.test(name) && name.length <= MAX_NAME_LENGTH;
        },
      ),
    );
  });

  describe('collisions', () => {
    it('keeps the name for the higher-priority installation and suffixes the others _2, _3', () => {
      const out = resolveNames(
        [
          { key: 'a', installationId: 'i1', priority: 0, prefix: 'x', upstreamName: 'run' },
          { key: 'b', installationId: 'i2', priority: 1, prefix: 'x', upstreamName: 'run' },
          { key: 'c', installationId: 'i3', priority: 2, prefix: 'x', upstreamName: 'run' },
        ],
        'always',
      );
      expect(out.map((o) => o.name)).toEqual(['x__run', 'x__run_2', 'x__run_3']);
      expect(out.filter((o) => o.collided).map((o) => o.key)).toEqual(['b', 'c']);
    });

    it('honors exact override names and lets them collide like any other', () => {
      const out = resolveNames(
        [
          {
            key: 'a',
            installationId: 'i1',
            priority: 0,
            prefix: 'x',
            upstreamName: 'run',
            exactName: 'run',
          },
          {
            key: 'b',
            installationId: 'i2',
            priority: 1,
            prefix: 'y',
            upstreamName: 'go',
            exactName: 'run',
          },
        ],
        'always',
      );
      expect(out.map((o) => o.name)).toEqual(['run', 'run_2']);
    });

    it('onCollision prefixes only names that collide', () => {
      const out = resolveNames(
        [
          { key: 'a', installationId: 'i1', priority: 0, prefix: 'x', upstreamName: 'run' },
          { key: 'b', installationId: 'i2', priority: 1, prefix: 'y', upstreamName: 'run' },
          { key: 'c', installationId: 'i2', priority: 1, prefix: 'y', upstreamName: 'solo' },
        ],
        'onCollision',
      );
      expect(out.map((o) => o.name)).toEqual(['x__run', 'y__run', 'solo']);
    });

    it('property: resolved names are unique and valid', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({ prefix: fc.constantFrom('a', 'b'), up: fc.constantFrom('t1', 't2', 't3') }),
            { minLength: 1, maxLength: 12 },
          ),
          (items) => {
            const out = resolveNames(
              items.map((i, n) => ({
                key: String(n),
                installationId: i.prefix,
                priority: n,
                prefix: i.prefix,
                upstreamName: i.up,
              })),
              'always',
            );
            const names = out.map((o) => o.name);
            return new Set(names).size === names.length && names.every((n) => NAME_PATTERN.test(n));
          },
        ),
      );
    });

    it('keeps suffixed names within 128 chars', () => {
      const long = 'z'.repeat(200);
      const out = resolveNames(
        [
          { key: 'a', installationId: 'i1', priority: 0, prefix: 'p', upstreamName: long },
          { key: 'b', installationId: 'i2', priority: 1, prefix: 'p', upstreamName: long },
        ],
        'always',
      );
      expect(out[1]?.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(out[0]?.name).not.toBe(out[1]?.name);
    });
  });
});

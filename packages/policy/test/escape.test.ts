import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PolicyGenerationError } from '../src';
import { cedar, policyToJson } from '../src/cedar';
import {
  assertSafeId,
  cedarString,
  escapeCedarString,
  globToCedarLike,
  isGlob,
} from '../src/escape';

/** A one-policy document whose `when` clause compares `resource.name` with the given literal. */
const policyWith = (literal: string): string =>
  `permit (principal, action, resource) when { resource.name == ${literal} };`;

const likePolicy = (pattern: string): string =>
  `permit (principal, action, resource) when { resource.name like ${pattern} };`;

const policyCount = (text: string): number => {
  const out = cedar.policySetTextToParts(text);
  if (out.type !== 'success') throw new Error('does not parse');
  return out.policies.length;
};

describe('10.3 escapeCedarString', () => {
  it.each([
    ['quote', '"', '\\"'],
    ['backslash', '\\', '\\\\'],
    ['newline', '\n', '\\n'],
    ['carriage return', '\r', '\\r'],
    ['tab', '\t', '\\t'],
    ['NUL', '\0', '\\0'],
    ['other control char', '\u0001', '\\u{1}'],
    ['DEL', '\u007f', '\\u{7f}'],
  ])('10.3 escapes %s', (_name, input, expected) => {
    expect(escapeCedarString(input)).toBe(expected);
  });

  it('10.3 leaves ordinary text, unicode and astral characters untouched', () => {
    expect(escapeCedarString('github/search_code')).toBe('github/search_code');
    expect(escapeCedarString('日本語 ✓ 😀')).toBe('日本語 ✓ 😀');
  });

  it('10.3 replaces a lone surrogate, which Cedar text cannot carry', () => {
    expect(escapeCedarString('a\ud800b')).toBe('a�b');
  });

  it('10.3 a quote cannot close the literal and start a new policy', () => {
    const hostile =
      '"; } forbid (principal, action, resource); permit (principal, action, resource) when { "x" == "';
    const text = policyWith(cedarString(hostile));
    expect(policyCount(text)).toBe(1);
    expect(policyToJson(text).effect).toBe('permit');
  });

  it('10.3 a trailing backslash cannot escape the closing quote', () => {
    expect(policyCount(policyWith(cedarString('tail\\')))).toBe(1);
  });

  it('10.3 any string yields exactly one parseable policy', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        expect(policyCount(policyWith(cedarString(value)))).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe('10.3 globToCedarLike', () => {
  it('10.3 turns * into the only wildcard', () => {
    expect(globToCedarLike('delete_*')).toBe('"delete_*"');
    expect(globToCedarLike('*')).toBe('"*"');
    expect(globToCedarLike('a*b*c')).toBe('"a*b*c"');
    expect(globToCedarLike('plain')).toBe('"plain"');
  });

  it('10.3 escapes everything around the wildcards', () => {
    expect(globToCedarLike('say "hi"*')).toBe('"say \\"hi\\"*"');
    expect(globToCedarLike('a\\b*')).toBe('"a\\\\b*"');
  });

  it.each(['?', '[a-z]', '{a,b}', 'x]', 'x}', 'te?st*'])(
    '10.3 rejects the unsupported glob syntax in %s',
    (glob) => {
      expect(() => globToCedarLike(glob)).toThrow(PolicyGenerationError);
    },
  );

  it('10.3 a hostile glob stays inside its pattern', () => {
    const text = likePolicy(globToCedarLike('"; permit (principal, action, resource); //*'));
    expect(policyCount(text)).toBe(1);
  });

  it('10.3 produces one parseable pattern for arbitrary glob-safe input', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }).filter((s) => !/[?[\]{}]/.test(s)),
        (glob) => {
          expect(policyCount(likePolicy(globToCedarLike(glob)))).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('10.3 isGlob and assertSafeId', () => {
  it('10.3 isGlob is true only when there is a *', () => {
    expect(isGlob('a*')).toBe(true);
    expect(isGlob('abc')).toBe(false);
    expect(isGlob('a?')).toBe(false);
  });

  it.each(['team-1', 'user_42', 'inst.7:a', 'A'.repeat(128), '0'])('10.3 accepts id %s', (id) => {
    expect(assertSafeId(id, 'id')).toBe(id);
  });

  it.each([
    '',
    'A'.repeat(129),
    'has space',
    'quote"',
    'back\\slash',
    'new\nline',
    'semi;colon',
    'slash/x',
    'ünï',
    '"); forbid (principal, action, resource); //',
  ])('10.3 rejects unsafe id %j', (id) => {
    expect(() => assertSafeId(id, 'team id')).toThrow(PolicyGenerationError);
  });

  it('10.3 names what was unsafe and carries the offending id', () => {
    try {
      assertSafeId('bad id', 'team id');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyGenerationError);
      expect((error as PolicyGenerationError).message).toBe('Unsafe team id');
      expect((error as PolicyGenerationError).data).toEqual({ id: 'bad id' });
    }
  });
});

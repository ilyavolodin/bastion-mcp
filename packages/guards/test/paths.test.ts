import { describe, expect, it } from 'vitest';
import { compilePathPattern, getAtPath, joinIndex, joinKey, parsePath, setAtPath } from '../src';

describe('13.3 segment paths', () => {
  it('13.3 joins simple keys with dots and others as quoted brackets', () => {
    expect(joinKey('', 'content')).toBe('content');
    expect(joinKey('arguments', 'query')).toBe('arguments.query');
    expect(joinKey('arguments', 'a.b')).toBe('arguments["a.b"]');
    expect(joinIndex('content', 2)).toBe('content[2]');
  });

  it('13.3 round-trips a joined path through parsePath', () => {
    const path = joinKey(joinIndex(joinKey('', 'rows'), 0), 'a "q" key');
    expect(parsePath(path)).toEqual([
      { kind: 'key', value: 'rows' },
      { kind: 'index', value: 0 },
      { kind: 'key', value: 'a "q" key' },
    ]);
  });

  it('13.4 parses wildcard tokens', () => {
    expect(parsePath('a.*.b[*].**')).toEqual([
      { kind: 'key', value: 'a' },
      { kind: 'any' },
      { kind: 'key', value: 'b' },
      { kind: 'anyIndex' },
      { kind: 'deep' },
    ]);
  });

  it.each(['a[', 'a[x]', 'a["b"', 'a["b"x]'])('13.3 rejects malformed path %s', (bad) => {
    expect(() => parsePath(bad)).toThrow(SyntaxError);
  });
});

describe('13.4 path patterns', () => {
  const match = (pattern: string, path: string) => compilePathPattern(pattern)(path);

  it('13.4 matches exact paths only', () => {
    expect(match('content[0].text', 'content[0].text')).toBe(true);
    expect(match('content[0].text', 'content[1].text')).toBe(false);
    expect(match('content', 'content.text')).toBe(false);
  });

  it('13.4 * is one key or index, [*] is any index but never a key', () => {
    expect(match('arguments.*', 'arguments.query')).toBe(true);
    expect(match('arguments.*', 'arguments[3]')).toBe(true);
    expect(match('arguments.*', 'arguments.a.b')).toBe(false);
    expect(match('content[*].text', 'content[9].text')).toBe(true);
    expect(match('content[*].text', 'content.x.text')).toBe(false);
  });

  it('13.4 ** spans any number of steps, including none', () => {
    expect(match('**.text', 'text')).toBe(true);
    expect(match('**.text', 'content[0].text')).toBe(true);
    expect(match('a.**', 'a')).toBe(true);
    expect(match('a.**.z', 'a.b[1].c.z')).toBe(true);
    expect(match('a.**.z', 'a.b[1].c.y')).toBe(false);
  });

  it('13.4 answers repeat queries from the cache with the same result', () => {
    const m = compilePathPattern('a.*');
    expect(m('a.b')).toBe(true);
    expect(m('a.b')).toBe(true);
    expect(m('x.b')).toBe(false);
    expect(m('x.b')).toBe(false);
  });
});

describe('13.3 reading and writing by path', () => {
  const root = { content: [{ text: 'hi' }, { text: 'yo' }], 'a.b': { c: 1 } };

  it('13.3 reads nested values and returns undefined for absent paths', () => {
    expect(getAtPath(root, 'content[1].text')).toBe('yo');
    expect(getAtPath(root, '["a.b"].c')).toBe(1);
    expect(getAtPath(root, 'content[5].text')).toBeUndefined();
    expect(getAtPath(root, 'missing.deeper')).toBeUndefined();
  });

  it('13.3 never reads inherited properties', () => {
    expect(getAtPath({}, 'constructor')).toBeUndefined();
    expect(getAtPath({}, '__proto__')).toBeUndefined();
  });

  it('13.3 setAtPath copies along the path and leaves the original untouched', () => {
    const out = setAtPath(root, 'content[0].text', 'bye') as typeof root;
    expect(out.content[0]?.text).toBe('bye');
    expect(root.content[0]?.text).toBe('hi');
    expect(out.content[1]).toBe(root.content[1]);
  });

  it('13.3 setAtPath leaves the value unchanged when the path is absent', () => {
    expect(setAtPath(root, 'content[7].text', 'x')).toEqual(root);
    expect(setAtPath(root, 'nope', 'x')).toEqual(root);
    expect(setAtPath(root, '__proto__.polluted', 'x')).toEqual(root);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

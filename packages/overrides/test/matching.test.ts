import { describe, expect, it } from 'vitest';
import { globMatches, isGlobKey, matchingEntries } from '../src/matching';

describe('12.3 matching', () => {
  it('12.3 exact keys match exactly', () => {
    const m = matchingEntries({ create_issue: 1, other: 2 }, 'create_issue');
    expect(m).toEqual([{ key: 'create_issue', value: 1, exact: true }]);
  });

  it('12.3 globs match with picomatch', () => {
    expect(globMatches('delete_*', 'delete_issue')).toBe(true);
    expect(globMatches('delete_*', 'create_issue')).toBe(false);
    expect(globMatches('get_?', 'get_a')).toBe(true);
  });

  it('12.3 exact keys apply last', () => {
    const m = matchingEntries(
      { create_issue: 'exact', '*': 'all', 'create_*': 'prefix' },
      'create_issue',
    );
    expect(m.map((e) => e.value)).toEqual(['all', 'prefix', 'exact']);
  });

  it('12.3 globs apply from shortest to longest so the more specific pattern wins', () => {
    const m = matchingEntries(
      { 'git_create_*': 'long', 'git_*': 'short', '*': 'all' },
      'git_create_issue',
    );
    expect(m.map((e) => e.value)).toEqual(['all', 'short', 'long']);
  });

  it('12.3 equal-length globs are ordered deterministically', () => {
    const a = matchingEntries({ 'b*': 1, 'a*': 2 }, 'ab');
    const b = matchingEntries({ 'a*': 2, 'b*': 1 }, 'ab');
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    expect(a).toHaveLength(1);
  });

  it('12.3 keys that do not match are skipped', () => {
    expect(matchingEntries({ 'x_*': 1 }, 'y_a')).toEqual([]);
  });

  it('12.3 URIs match as keys, exact and glob', () => {
    const rec = { 'file:///secrets/*': 'g', 'file:///secrets/a.txt': 'e' };
    expect(matchingEntries(rec, 'file:///secrets/a.txt').map((e) => e.value)).toEqual(['g', 'e']);
    expect(matchingEntries(rec, 'file:///public/a.txt')).toEqual([]);
  });

  it('12.3 URI templates match as exact keys; braces are not glob syntax', () => {
    const key = 'repo://{owner}/{repo}/contents/{path}';
    expect(isGlobKey(key)).toBe(false);
    expect(matchingEntries({ [key]: 1 }, key)).toHaveLength(1);
    expect(matchingEntries({ [key]: 1 }, 'repo://acme/web/contents/x')).toEqual([]);
  });

  it('12.3 negation and extglob syntax are not interpreted', () => {
    expect(globMatches('!a*', '!abc')).toBe(true);
    expect(globMatches('!a*', 'xbc')).toBe(false);
  });
});

/**
 * Key matching (12.3, 7.4). Keys are exact upstream names, URIs or URI templates, or globs.
 * For one item exact keys apply last; globs apply from shortest to longest pattern so the more
 * specific pattern wins.
 */
import picomatch from 'picomatch';

const GLOB_CHARS = /[*?[\]]/;

/** Braces are never glob syntax: `{owner}` in a URI template is literal text. */
export const isGlobKey = (key: string): boolean => GLOB_CHARS.test(key);

const matchers = new Map<string, (subject: string) => boolean>();
const matcherFor = (pattern: string): ((subject: string) => boolean) => {
  let fn = matchers.get(pattern);
  if (!fn) {
    fn = picomatch(pattern, { nobrace: true, noext: true, nonegate: true, dot: true });
    matchers.set(pattern, fn);
  }
  return fn;
};

export const globMatches = (pattern: string, subject: string): boolean =>
  matcherFor(pattern)(subject);

export type MatchedEntry<T> = { key: string; value: T; exact: boolean };

/** Entries whose key matches `subject`, in application order: globs short to long, exact last. */
export const matchingEntries = <T>(
  record: Readonly<Record<string, T>>,
  subject: string,
): MatchedEntry<T>[] => {
  const globs: MatchedEntry<T>[] = [];
  let exact: MatchedEntry<T> | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key === subject) exact = { key, value, exact: true };
    else if (isGlobKey(key) && globMatches(key, subject)) globs.push({ key, value, exact: false });
  }
  globs.sort((a, b) => a.key.length - b.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return exact ? [...globs, exact] : globs;
};

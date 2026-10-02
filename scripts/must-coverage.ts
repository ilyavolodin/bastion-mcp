/**
 * `scripts/check-must-coverage.ts` support (tdd.md 23.5): every section of the specification that
 * contains a MUST needs at least one test whose title starts with that section number.
 */

export type MustSection = { id: string; heading: string };

const HEADING = /^(#{2,4})\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/;
const REQUIREMENT = /\bMUST\b/;

/** Sections (by number) whose own body, up to the next heading, contains an uppercase MUST. */
export const extractMustSections = (markdown: string): MustSection[] => {
  const sections: MustSection[] = [];
  let current: MustSection | undefined;
  let found = false;
  const close = () => {
    if (current && found) sections.push(current);
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { id: heading[2] as string, heading: (heading[3] as string).trim() };
      found = false;
    } else if (/^#{1,6}\s/.test(line)) {
      close();
      current = undefined;
      found = false;
    } else if (current && REQUIREMENT.test(line)) {
      found = true;
    }
  }
  close();
  return sections;
};

const TITLE = /\b(?:it|test|describe)(?:\.\w+)*(?:\([^)]*\))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

/** Leading section numbers of every `it`, `test` and `describe` title in a source file. */
export const extractTestTitles = (source: string): string[] => {
  const ids: string[] = [];
  for (const match of source.matchAll(TITLE)) {
    const lead = /^(\d+(?:\.\d+)+)(?=[\s:])/.exec(match[2] as string);
    if (lead) ids.push(lead[1] as string);
  }
  return ids;
};

/** A test titled `7.2 ...` covers section `7.2` and its parent `7`, but not `7.1`. */
export const findUncoveredSections = (
  sections: readonly MustSection[],
  covered: ReadonlySet<string>,
): MustSection[] => {
  const coveredOrParent = new Set<string>();
  for (const id of covered) {
    const parts = id.split('.');
    for (let n = 1; n <= parts.length; n++) coveredOrParent.add(parts.slice(0, n).join('.'));
  }
  return sections.filter((section) => !coveredOrParent.has(section.id));
};

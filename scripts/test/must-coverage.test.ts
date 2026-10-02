import { describe, expect, it } from 'vitest';
import {
  extractMustSections,
  extractTestTitles,
  findUncoveredSections,
} from '../must-coverage';

const doc = `
# Title

## 1. Summary
Nothing mandatory here.

### 1.1 Goals
The system MUST proxy everything.

## 6. Protocol

### 6.5 Input-required bridging
On a retry Bastion MUST decrypt and MUST NOT forward the state.

### 6.6 Notifications
Clients may subscribe (should, not must).

## 7. Routing
Compilation of an endpoint MUST finish in under 50 ms.

### 7.1 Endpoint URLs
Describes URLs.
`;

describe('23.5 must coverage tooling', () => {
  it('lists every section whose own text contains an uppercase MUST', () => {
    expect(extractMustSections(doc).map((s) => s.id)).toEqual(['1.1', '6.5', '7']);
  });

  it('does not treat lowercase "must" as a requirement', () => {
    expect(extractMustSections('## 3. X\nIt must work.\n')).toEqual([]);
  });

  it('extracts the leading section number of test and describe titles', () => {
    const source = `
      describe('6.5 input required', () => {
        it('6.5 forwards inputResponses to the same installation', () => {});
        it("7.2 compiles in under 50 ms", () => {});
        it.each([1])('8.7 rejects ranges %s', () => {});
        it('no section number here', () => {});
      });`;
    expect(extractTestTitles(source)).toEqual(['6.5', '6.5', '7.2', '8.7']);
  });

  it('reports sections with no test, matching a parent section number', () => {
    const sections = extractMustSections(doc);
    const missing = findUncoveredSections(sections, new Set(['6.5', '7.2']));
    expect(missing.map((s) => s.id)).toEqual(['1.1']);
  });

  it('a test titled with a subsection number covers its parent section', () => {
    const sections = extractMustSections(doc);
    expect(findUncoveredSections(sections, new Set(['7.2'])).map((s) => s.id)).toEqual([
      '1.1',
      '6.5',
    ]);
  });
});

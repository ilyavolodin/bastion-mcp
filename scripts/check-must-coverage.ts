/**
 * Usage: `tsx scripts/check-must-coverage.ts [--strict]`
 * Lists spec sections containing a MUST that no test title cites (tdd.md 23.5). Without `--strict`
 * it only reports; CI turns on `--strict` once the milestone owning those sections has landed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCoveredIds, extractMustSections, findUncoveredSections } from './must-coverage';

const root = join(import.meta.dirname, '..');
const covered = collectCoveredIds(root);

const sections = extractMustSections(readFileSync(join(root, 'docs', 'tdd.md'), 'utf8'));
const missing = findUncoveredSections(sections, covered);

console.log(
  `${sections.length - missing.length}/${sections.length} sections with a MUST are covered`,
);
for (const section of missing) console.log(`  missing: ${section.id} ${section.heading}`);

if (missing.length > 0 && process.argv.includes('--strict')) process.exit(1);

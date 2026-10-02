/**
 * Usage: `tsx scripts/check-must-coverage.ts [--strict]`
 * Lists spec sections containing a MUST that no test title cites (tdd.md 23.5). Without `--strict`
 * it only reports; CI turns on `--strict` once the milestone owning those sections has landed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractMustSections, extractTestTitles, findUncoveredSections } from './must-coverage';

const root = join(import.meta.dirname, '..');

const testFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
};

const covered = new Set<string>();
for (const base of ['packages', 'apps']) {
  try {
    for (const file of testFiles(join(root, base))) {
      for (const id of extractTestTitles(readFileSync(file, 'utf8'))) covered.add(id);
    }
  } catch {
    // the directory does not exist yet
  }
}

const sections = extractMustSections(readFileSync(join(root, 'docs', 'tdd.md'), 'utf8'));
const missing = findUncoveredSections(sections, covered);

console.log(
  `${sections.length - missing.length}/${sections.length} sections with a MUST are covered`,
);
for (const section of missing) console.log(`  missing: ${section.id} ${section.heading}`);

if (missing.length > 0 && process.argv.includes('--strict')) process.exit(1);

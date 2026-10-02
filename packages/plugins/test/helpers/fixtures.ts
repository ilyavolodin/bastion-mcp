import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export * from './items';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, '..', 'golden');

/** Golden-file assertion; run with `UPDATE_GOLDEN=1` to (re)write the files, then review the diff. */
export const expectGolden = (name: string, actual: string): void => {
  const path = join(goldenDir, `${name}.golden`);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
};

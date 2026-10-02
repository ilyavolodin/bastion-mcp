// Post-build step: copies the Prisma migrations next to the bundle (apps/server/prisma/migrations), where
// `bastion migrate` looks first, and checks the build produced every entry the Dockerfile contract names.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, '..', '..', 'packages', 'db', 'prisma', 'migrations');
const to = join(root, 'prisma', 'migrations');

if (!existsSync(from)) throw new Error(`migrations not found at ${from}`);
rmSync(to, { recursive: true, force: true });
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations to ${to}`);

for (const file of ['main.js', 'otel.js', 'cli.js']) {
  if (!existsSync(join(root, 'dist', file))) throw new Error(`build did not produce dist/${file}`);
}

// Node ESM resolves only exact files for package subpaths without an "exports" entry: `packages/plugins` imports
// `ajv/dist/2020` (no extension), which works under bundlers but not at runtime.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

for (const name of readdirSync(join(root, 'dist')).filter((f) => f.endsWith('.js'))) {
  const path = join(root, 'dist', name);
  const text = readFileSync(path, 'utf8');
  const fixed = text.replaceAll('from "ajv/dist/2020"', 'from "ajv/dist/2020.js"');
  if (fixed !== text) writeFileSync(path, fixed);
}

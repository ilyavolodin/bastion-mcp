// `pnpm build` at the repository root must work on machines without bun: the single-file helper
// (bun build --compile) is only produced when bun is on PATH. Release builds use `build:targets`.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const probe = spawnSync('bun', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.log(
    'bastion-credential: bun not found, skipping the compiled helper (see build:targets)',
  );
  process.exit(0);
}
mkdirSync('dist', { recursive: true });
const result = spawnSync(
  'bun',
  ['build', '--compile', '--minify', 'src/main.ts', '--outfile', 'dist/bastion-credential'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);

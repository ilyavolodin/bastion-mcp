// Builds the single-file helper for every release target (25.6) with `bun build --compile`.
// Signing and notarization (macOS), Authenticode (Windows) happen later in the release pipeline.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const targets = [
  ['bun-darwin-arm64', 'bastion-credential-darwin-arm64'],
  ['bun-darwin-x64', 'bastion-credential-darwin-x64'],
  ['bun-windows-x64', 'bastion-credential-windows-x64.exe'],
  ['bun-linux-x64', 'bastion-credential-linux-x64'],
  ['bun-linux-arm64', 'bastion-credential-linux-arm64'],
];

mkdirSync('dist', { recursive: true });
for (const [target, out] of targets) {
  const result = spawnSync(
    'bun',
    [
      'build',
      '--compile',
      '--minify',
      `--target=${target}`,
      'src/main.ts',
      '--outfile',
      `dist/${out}`,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

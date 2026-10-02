/**
 * CI check: `pnpm --filter @bastion-mcp/api-client openapi:check`.
 *
 * Builds the current OpenAPI document and compares it with the committed `openapi.snapshot.json`.
 * Breaking changes (removed operations, removed or retyped response fields, new required request fields,
 * ...) fail unless `info.version` has a higher major number than the snapshot. `--update` rewrites the
 * snapshot after a deliberate change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '@bastion-mcp/api';
import { diffOpenApi } from '../src/openapi-diff';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = resolve(root, 'openapi.snapshot.json');

const main = async (): Promise<number> => {
  const current = await buildOpenApiDocument();
  if (process.argv.includes('--update') || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
    console.log('openapi.snapshot.json updated');
    return 0;
  }
  const snapshot: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const result = diffOpenApi(snapshot, current);
  for (const c of result.compatible) console.log(`compatible  ${c.where}: ${c.message}`);
  for (const c of result.breaking) console.log(`BREAKING    ${c.where}: ${c.message}`);
  if (result.needsVersionBump) {
    console.error(
      `\n${result.breaking.length} breaking change(s) without a major version bump (${result.versionBefore} -> ${result.versionAfter}).` +
        '\nBump API_VERSION in packages/api/src/openapi.ts, then run `openapi:check --update`.',
    );
    return 1;
  }
  if (result.breaking.length === 0 && result.compatible.length > 0) {
    console.log('\nCompatible changes only: run `openapi:check --update` to refresh the snapshot.');
  }
  return 0;
};

process.exit(await main());

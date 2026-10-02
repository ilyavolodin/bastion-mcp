#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { parseRunConfig } from './args';
import { checkAll, formatReport, resultFileSchema } from './results';
import { SCENARIOS } from './scenarios';

/**
 *   tsx src/cli.ts list
 *   tsx src/cli.ts run --scenario <id> --url <bastion url> --token <pat> [...]
 *   tsx src/cli.ts annotate <result.json> --worker-memory-max-bytes <n>
 *   tsx src/cli.ts check [--require-all] <result.json>...
 * `check` exits 1 when any target of tdd 23.4 is not met.
 */

const readResult = (path: string) => resultFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'list': {
      for (const s of SCENARIOS) {
        console.log(`${s.id}\n  row:      ${s.row}\n  topology: ${s.topology}\n  ${s.describe}`);
      }
      return 0;
    }
    case 'run': {
      // Imported lazily so `check` and the unit tests never load the SDK.
      const { runScenario } = await import('./runner');
      const cfg = parseRunConfig(rest, process.env);
      console.error(`running ${cfg.scenario.id} against ${cfg.url} for ${cfg.durationSec}s`);
      const result = await runScenario(cfg);
      mkdirSync(dirname(cfg.out), { recursive: true });
      writeFileSync(cfg.out, `${JSON.stringify(result, null, 2)}\n`);
      console.error(`wrote ${cfg.out}`);
      return 0;
    }
    case 'annotate': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { 'worker-memory-max-bytes': { type: 'string' } },
        allowPositionals: true,
      });
      const file = positionals[0];
      const bytes = Number(values['worker-memory-max-bytes']);
      if (!file || !Number.isFinite(bytes) || bytes < 0) {
        console.error('usage: annotate <result.json> --worker-memory-max-bytes <n>');
        return 2;
      }
      const result = readResult(file);
      writeFileSync(
        file,
        `${JSON.stringify({ ...result, workerMemoryMaxBytes: bytes }, null, 2)}\n`,
      );
      return 0;
    }
    case 'check': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { 'require-all': { type: 'boolean' } },
        allowPositionals: true,
      });
      if (positionals.length === 0) {
        console.error('usage: check [--require-all] <result.json>...');
        return 2;
      }
      const report = checkAll(positionals.map(readResult), {
        requireAll: values['require-all'] === true,
      });
      console.log(formatReport(report));
      return report.passed ? 0 : 1;
    }
    default:
      console.error('usage: cli.ts list | run | annotate | check');
      return 2;
  }
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);

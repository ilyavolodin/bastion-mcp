#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
/**
 * `bastion` (20.1). `node dist/main.js <command>` and the `bastion` wrapper of the image dispatch here; the default
 * command is `serve`, which hands over to `startServer` of `./server`.
 */
import { errorMessage } from '@bastion-mcp/core';
import { execute, parseArgs } from './cli/commands';

export { checkConfig, execute, formatTable, parseArgs } from './cli/commands';
export { exportConfig, importConfig } from './cli/config-io';

/** True when argv names a command other than `serve` (so `main` should run the CLI instead of the server). */
export const isCliCommand = (argv: readonly string[]): boolean => {
  const { command, flags } = parseArgs(argv);
  return flags.has('help') || command !== 'serve';
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** Runs the CLI and returns the exit code. Never calls `process.exit`. */
export const runCli = async (argv: readonly string[], env = process.env): Promise<number> => {
  const parsed = parseArgs(argv);
  if (parsed.command === 'serve' && !parsed.flags.has('help')) {
    const { startServer } = await import('./server');
    await startServer();
    return 0;
  }
  return execute(argv, env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    stdin: readStdin,
  });
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    /[\\/]cli\.(js|mjs|ts)$/.test(entry) &&
    import.meta.url === pathToFileURL(entry).href
  );
};

if (invokedDirectly()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // `serve` keeps the event loop alive; any other command is finished and may exit.
      if (parseArgs(process.argv.slice(2)).command !== 'serve') process.exit(code);
    },
    (error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exit(1);
    },
  );
}

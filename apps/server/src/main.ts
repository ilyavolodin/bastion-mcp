/**
 * Process entry (`node --import ./dist/otel.js ./dist/main.js [command]`). With no command (or `serve`) it runs the
 * server for `BASTION_ROLE`; with a CLI command (migrate, check-config, create-admin, rotate-keys, export-config,
 * import-config) it dispatches to the CLI of 20.1.
 */
import { ConfigError } from '@bastion-mcp/core';
import { isCliCommand, runCli } from './cli';
import { startServer } from './server';

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (isCliCommand(argv)) {
    process.exitCode = await runCli(argv);
    return;
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const issue of error.issues)
        console.error(`config error: ${issue.path}: ${issue.message}`);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exit(1);
  }
  let signalled = false;
  const shutdown = (signal: string): void => {
    if (signalled) return;
    signalled = true;
    server.infra.logger.info({ signal }, 'signal received');
    // Hard stop after the drain budget plus slack (21.2 allows 25 s of in-flight work).
    const hard = setTimeout(() => process.exit(1), 35_000);
    hard.unref();
    server
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

void main();

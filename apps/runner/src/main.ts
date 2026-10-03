import { parseArgs } from './args';
import { startEgressForwarder } from './egress-forward';
import { pickEnv } from './env';
import { createInstaller } from './install';
import { createRunner } from './server';

/** Environment copied into installer subprocesses only. */
const INSTALL_PASSTHROUGH = ['UV_PYTHON_INSTALL_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];

/** `bastion-runner` entrypoint, bundled to `runner.mjs` (8.3). */
const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const runner = createRunner({
    installer: createInstaller(),
    installPassthrough: pickEnv(INSTALL_PASSTHROUGH, process.env),
  });
  const forwarder = args.egress
    ? await startEgressForwarder({ socketPath: args.egress.socketPath })
    : undefined;
  const { address } = await runner.listen(args.listen);
  process.stdout.write(`${JSON.stringify({ msg: 'bastion-runner listening', address })}\n`);
  const shutdown = (): void => {
    void forwarder?.close();
    void runner.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

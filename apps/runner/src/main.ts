/* v8 ignore file */
import { parseArgs } from './args';
import { startEgressForwarder } from './egress-forward';
import { createInstaller } from './install';
import { createRunner } from './server';

/** `bastion-runner` entrypoint, bundled to `runner.mjs` (8.3). */
const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const passthrough: Record<string, string> = {};
  for (const name of ['UV_PYTHON_INSTALL_DIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    const value = process.env[name];
    if (value) passthrough[name] = value;
  }
  const runner = createRunner({
    installer: createInstaller(),
    installPassthrough: passthrough,
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

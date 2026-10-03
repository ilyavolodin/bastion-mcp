export type ListenTarget =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; path: string };

export type RunnerArgs = { listen: ListenTarget; egress: { socketPath: string } | undefined };

export const DEFAULT_LISTEN_HOST = '0.0.0.0';
export const DEFAULT_LISTEN_PORT = 8080;

const parseUnix = (value: string): string | undefined =>
  value.startsWith('unix:') ? value.slice(5) : undefined;

/** Parses `--listen unix:<path>` (default `0.0.0.0:8080`) and `--egress unix:<path>` (8.3, 8.5). */
export const parseArgs = (argv: readonly string[]): RunnerArgs => {
  let listen: ListenTarget = { kind: 'tcp', host: DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT };
  let egress: RunnerArgs['egress'];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--listen' && flag !== '--egress') throw new Error(`unknown argument "${flag}"`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    const unix = parseUnix(value);
    if (flag === '--egress') {
      if (unix === undefined) throw new Error('--egress must be unix:<path>');
      egress = { socketPath: unix };
    } else if (unix !== undefined) {
      listen = { kind: 'unix', path: unix };
    } else {
      const at = value.lastIndexOf(':');
      const port = Number(value.slice(at + 1));
      if (at <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --listen value "${value}"`);
      }
      listen = { kind: 'tcp', host: value.slice(0, at), port };
    }
  }
  return { listen, egress };
};

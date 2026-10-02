import { CredentialError } from './config';
import type { DeviceAuthorization } from './device-flow';

export type CliIo = {
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type CliDeps = {
  io: CliIo;
  server: () => URL;
  getAccessToken: () => Promise<string>;
};

/** Parses the git credential helper input: `key=value` lines up to a blank line. */
export const parseCredentialRequest = (input: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (line === '') break;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
};

/** Whether git is asking for Bastion's host (same scheme and host, including the port). */
export const isBastionRequest = (request: Record<string, string>, server: URL): boolean => {
  const protocol = request.protocol;
  const host = request.host;
  if (!protocol || !host) return false;
  return `${protocol}:` === server.protocol && host.toLowerCase() === server.host.toLowerCase();
};

export const verificationMessage = (a: DeviceAuthorization): string =>
  `To sign in to Bastion, open ${a.verification_uri_complete ?? a.verification_uri}` +
  `${a.verification_uri_complete ? '' : ` and enter the code ${a.user_code}`}\n`;

const USAGE = 'usage: bastion-credential <get|token|store|erase>\n';

/**
 * `bastion-credential get` (git credential helper protocol), `token` (a bare token for Claude
 * Desktop's `credentialHelper`), and the no-op `store`/`erase` git calls. Returns the exit code.
 * Tokens go to stdout only; diagnostics go to stderr and never contain a token.
 */
export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<number> => {
  const command = argv[0];
  try {
    switch (command) {
      case 'get': {
        const request = parseCredentialRequest(await deps.io.readStdin());
        if (!isBastionRequest(request, deps.server())) return 0; // not our host: let other helpers answer
        const token = await deps.getAccessToken();
        deps.io.stdout(`username=x-access-token\npassword=${token}\n`);
        return 0;
      }
      case 'token': {
        deps.io.stdout(await deps.getAccessToken());
        return 0;
      }
      case 'store':
      case 'erase':
        await deps.io.readStdin();
        return 0;
      default:
        deps.io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    deps.io.stderr(
      `bastion-credential: ${error instanceof CredentialError ? error.message : 'unexpected failure'}\n`,
    );
    return 1;
  }
};

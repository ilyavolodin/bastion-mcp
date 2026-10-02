import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export class CredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

const fileSchema = z.object({ url: z.string() });

export type ConfigDeps = {
  env: Record<string, string | undefined>;
  /** Reads a file; throws when missing. */
  readFile: (path: string) => string;
  home: string;
};

export const defaultConfigPath = (home: string = homedir()): string =>
  join(home, '.config', 'bastion', 'credential.json');

/** Normalizes a Bastion URL: https only (http on loopback for development), origin only. */
export const normalizeServerUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new CredentialError(`invalid Bastion URL: ${raw}`, { cause: error });
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CredentialError('the Bastion URL must use https');
  }
  return new URL(url.origin);
};

/** `BASTION_URL`, else `~/.config/bastion/credential.json` (`{ "url": "https://mcp.example.com" }`). */
export const resolveServerUrl = (deps: ConfigDeps): URL => {
  const fromEnv = deps.env.BASTION_URL?.trim();
  if (fromEnv) return normalizeServerUrl(fromEnv);
  const path = defaultConfigPath(deps.home);
  let text: string;
  try {
    text = deps.readFile(path);
  } catch (error) {
    throw new CredentialError(
      `set BASTION_URL or create ${path} with {"url": "https://your-bastion-host"}`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CredentialError(`${path} is not valid JSON`, { cause: error });
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) throw new CredentialError(`${path} must contain {"url": "..."}`);
  return normalizeServerUrl(parsed.data.url);
};

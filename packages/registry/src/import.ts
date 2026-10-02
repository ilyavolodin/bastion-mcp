import { type Injection, parseServerSpec, type ServerSpec } from '@bastion-mcp/core';
import { ZodError } from 'zod';
import { RegistryMappingError, RegistryUnavailableError } from './errors';
import { type MappingResult, type Prefer, sanitizeVariableName, serverJsonToSpec } from './mapping';
import type { FetchFn } from './ports';
import { type ServerJson, serverJsonSchema } from './server-json';

/** Importing a `server.json` or a client config snippet (11.3). */

export type PackageRuntime = 'npm' | 'pypi';

/** Resolves the exact current version of a package (11.3). */
export type VersionResolver = {
  latest(runtime: PackageRuntime, identifier: string, signal?: AbortSignal): Promise<string>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

const fetchJson = async (
  fetchFn: FetchFn,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  accept = 'application/json',
): Promise<unknown> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { accept },
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (error) {
    throw new RegistryUnavailableError('package registry request failed', { cause: error });
  }
  if (response.status === 404) throw new RegistryMappingError('package was not found');
  if (!response.ok) {
    throw new RegistryUnavailableError(`package registry answered HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new RegistryUnavailableError('package registry answered invalid JSON', { cause: error });
  }
};

type ResolverOptions = { fetch?: FetchFn; timeoutMs?: number };

/** npm packument lookup against `BASTION_NPM_REGISTRY` (or the public registry). */
export const createNpmVersionResolver = (
  registryUrl: string,
  options: ResolverOptions = {},
): VersionResolver => ({
  async latest(_runtime, identifier, signal) {
    const path = identifier.startsWith('@')
      ? `@${encodeURIComponent(identifier.slice(1))}`
      : encodeURIComponent(identifier);
    const body = await fetchJson(
      options.fetch ?? fetch,
      `${trimSlash(registryUrl)}/${path}`,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
      'application/vnd.npm.install-v1+json, application/json',
    );
    const tags = (body as { 'dist-tags'?: { latest?: unknown } } | null)?.['dist-tags'];
    if (typeof tags?.latest !== 'string') {
      throw new RegistryMappingError(`npm package ${identifier} has no latest version`);
    }
    return tags.latest;
  },
});

/** PyPI JSON API lookup; the host comes from `BASTION_PYPI_INDEX_URL` (`.../simple` is swapped for `/pypi`). */
export const createPypiVersionResolver = (
  indexUrl: string,
  options: ResolverOptions = {},
): VersionResolver => ({
  async latest(_runtime, identifier, signal) {
    const root = trimSlash(indexUrl).replace(/\/simple$/, '');
    const body = await fetchJson(
      options.fetch ?? fetch,
      `${root}/pypi/${encodeURIComponent(identifier.toLowerCase())}/json`,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
    );
    const version = (body as { info?: { version?: unknown } } | null)?.info?.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new RegistryMappingError(`PyPI package ${identifier} has no version`);
    }
    return version;
  },
});

/** Routes by runtime to the npm or PyPI resolver. */
export const createVersionResolver = (config: {
  npmRegistry: string;
  pypiIndexUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}): VersionResolver => {
  const opts: ResolverOptions = {
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  };
  const npm = createNpmVersionResolver(config.npmRegistry, opts);
  const pypi = createPypiVersionResolver(config.pypiIndexUrl, opts);
  return {
    latest: (runtime, id, signal) => (runtime === 'npm' ? npm : pypi).latest(runtime, id, signal),
  };
};

// --- Client config snippet ------------------------------------------------------------------------------------------

export type ImportedServer = {
  /** Suggested display name. */
  name: string;
  description?: string;
  source: 'client-config' | 'server.json';
  spec: ServerSpec;
  warnings: string[];
};

const REJECTED_RUNNERS: Record<string, string> = {
  pnpx: 'pnpm dlx is not supported: use "npx -y <package>"',
  bunx: 'bunx is not supported: use "npx -y <package>" for npm packages or "uvx <package>" for PyPI',
  yarn: 'yarn dlx is not supported: use "npx -y <package>"',
  pnpm: 'pnpm dlx is not supported: use "npx -y <package>"',
  bun: 'bunx is not supported: use "npx -y <package>" for npm packages or "uvx <package>" for PyPI',
};

const SECRET_NAME = /(key|token|secret|password|passwd|credential|auth|bearer)/i;

const EXACT = /^\d+(?:\.\d+)+(?:[-+._]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;

const snippetSchema = {
  parse(input: unknown): Record<string, unknown> {
    let value = input;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch (error) {
        throw new RegistryMappingError('the snippet is not valid JSON', { cause: error });
      }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RegistryMappingError('the snippet must be a JSON object');
    }
    let record = value as Record<string, unknown>;
    // Accept `{ "mcpServers": { "name": {...} } }` and `{ "name": {...} }` with a single entry.
    const wrapper = record.mcpServers ?? record.servers;
    if (
      typeof wrapper === 'object' &&
      wrapper !== null &&
      !('command' in record) &&
      !('url' in record)
    ) {
      record = wrapper as Record<string, unknown>;
    }
    if (!('command' in record) && !('url' in record)) {
      const entries = Object.entries(record);
      const only = entries[0];
      if (entries.length === 1 && only && typeof only[1] === 'object' && only[1] !== null) {
        return { ...(only[1] as Record<string, unknown>), __name: only[0] };
      }
      if (entries.length > 1) {
        throw new RegistryMappingError(
          'the snippet contains several servers; import one at a time',
        );
      }
    }
    return record;
  },
};

const stringList = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new RegistryMappingError(`${label} must be an array of strings`);
  }
  return value as string[];
};

const stringRecord = (value: unknown, label: string): Record<string, string> => {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RegistryMappingError(`${label} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new RegistryMappingError(`${label}.${k} must be a string`);
    out[k] = v;
  }
  return out;
};

const runnerName = (command: string): string =>
  (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(cmd|exe|bat)$/, '');

type ParsedPackage = {
  runtime: PackageRuntime;
  identifier: string;
  version?: string;
  rest: string[];
};

const splitNpmSpec = (raw: string): { identifier: string; version?: string } => {
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { identifier: raw };
  return { identifier: raw.slice(0, at), version: raw.slice(at + 1) };
};

const splitPypiSpec = (raw: string): { identifier: string; version?: string } => {
  const eq = raw.indexOf('==');
  if (eq > 0) return { identifier: raw.slice(0, eq), version: raw.slice(eq + 2) };
  const at = raw.indexOf('@');
  if (at > 0) return { identifier: raw.slice(0, at), version: raw.slice(at + 1) };
  if (/[<>~!=]/.test(raw)) {
    throw new RegistryMappingError(
      `version range in "${raw}" is not allowed: Bastion pins one exact version`,
    );
  }
  return { identifier: raw };
};

const parseRunner = (command: string, args: string[]): ParsedPackage => {
  const runner = runnerName(command);
  if (runner in REJECTED_RUNNERS)
    throw new RegistryMappingError(REJECTED_RUNNERS[runner] as string);
  if (runner !== 'npx' && runner !== 'uvx') {
    throw new RegistryMappingError(
      `command "${command}" is not supported: use "npx -y <package>" (npm) or "uvx <package>" (PyPI)`,
    );
  }
  const runtime: PackageRuntime = runner === 'npx' ? 'npm' : 'pypi';
  let from: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (runtime === 'pypi' && arg === '--from') {
      from = args[index + 1];
      index += 1;
      continue;
    }
    if (runtime === 'pypi' && arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      continue;
    }
    if (runtime === 'npm' && (arg === '-p' || arg === '--package')) {
      from = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    break;
  }
  const first = args[index];
  const spec = from ?? first;
  if (!spec) throw new RegistryMappingError(`no package name found after "${runner}"`);
  const rest = args.slice(index + 1);
  const split = runtime === 'npm' ? splitNpmSpec(spec) : splitPypiSpec(spec);
  return { runtime, ...split, rest };
};

const resolveVersion = async (
  parsed: ParsedPackage,
  resolver: VersionResolver,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<string> => {
  const { version } = parsed;
  if (version && EXACT.test(version)) return version;
  if (version && version !== 'latest') {
    throw new RegistryMappingError(
      `version "${version}" of ${parsed.identifier} is a range or tag: Bastion pins one exact version`,
    );
  }
  const resolved = await resolver.latest(parsed.runtime, parsed.identifier, signal);
  if (!EXACT.test(resolved)) {
    throw new RegistryMappingError(`registry returned a non-exact version "${resolved}"`);
  }
  warnings.push(`version resolved to ${resolved} at import`);
  return resolved;
};

const finish = (candidate: unknown): ServerSpec => {
  try {
    return parseServerSpec(candidate);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RegistryMappingError(
        `import failed validation: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
};

const importRemoteSnippet = (
  record: Record<string, unknown>,
  warnings: string[],
): ImportedServer => {
  const url = record.url;
  if (typeof url !== 'string' || url.length === 0)
    throw new RegistryMappingError('url must be a string');
  const type = record.type ?? record.transport;
  const transport = type === 'sse' ? 'sse' : 'streamable-http';
  const headers = stringRecord(record.headers, 'headers');
  const specHeaders: { name: string; value: string }[] = [];
  const fields: { name: string; label: string }[] = [];
  const inject: Injection[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (SECRET_NAME.test(name)) {
      const field = sanitizeVariableName(name);
      fields.push({ name: field, label: name });
      const bearer = /^bearer\s/i.test(value);
      inject.push({
        to: 'header',
        name,
        value: bearer ? `Bearer {{secret.${field}}}` : `{{secret.${field}}}`,
      });
      warnings.push(
        `header ${name} was turned into a per-user secret field; its value was discarded`,
      );
    } else {
      specHeaders.push({ name, value });
    }
  }
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      throw new RegistryMappingError('url is not a valid URL');
    }
  })();
  const spec = finish({
    type: 'remote',
    transport,
    url,
    ...(specHeaders.length > 0 ? { headers: specHeaders } : {}),
    auth: fields.length > 0 ? { mode: 'userSecret', fields, inject } : { mode: 'none' },
  });
  return {
    name: typeof record.__name === 'string' ? record.__name : host,
    source: 'client-config',
    spec,
    warnings,
  };
};

/**
 * Imports `{ "command": "npx", "args": ["-y", "<pkg>"] }` (npx maps to npm, uvx to PyPI) and remote
 * `{ "url": ... }` snippets. The exact current version is resolved through `resolver` (11.3). Literal
 * secret-looking env values and headers are never kept: they become per-user secret fields.
 */
export const importFromClientConfig = async (
  snippet: unknown,
  options: { resolver: VersionResolver; signal?: AbortSignal },
): Promise<ImportedServer> => {
  const record = snippetSchema.parse(snippet);
  const warnings: string[] = [];
  if (typeof record.url === 'string') return importRemoteSnippet(record, warnings);

  if (typeof record.command !== 'string' || record.command.trim().length === 0) {
    throw new RegistryMappingError('the snippet needs a "command" or a "url"');
  }
  let command = record.command.trim();
  let args = stringList(record.args, 'args');
  if (args.length === 0 && /\s/.test(command)) {
    const [head, ...tail] = command.split(/\s+/);
    command = head as string;
    args = tail;
  }
  // `pnpm dlx` arrives as command "pnpm" with args ["dlx", ...].
  const parsed = parseRunner(command, args);
  const version = await resolveVersion(parsed, options.resolver, options.signal, warnings);

  const env = stringRecord(record.env, 'env');
  const environmentVariables: { name: string; value: string }[] = [];
  const fields: { name: string; label: string }[] = [];
  const inject: Injection[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name)) {
      const field = sanitizeVariableName(name);
      fields.push({ name: field, label: name });
      inject.push({ to: 'env', name, value: `{{secret.${field}}}` });
      warnings.push(`env ${name} was turned into a per-user secret field; its value was discarded`);
    } else {
      environmentVariables.push({ name, value });
    }
  }

  const packageArguments = parsed.rest.map((arg) => {
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      return { type: 'named' as const, name: arg.slice(0, eq), value: arg.slice(eq + 1) };
    }
    return { type: 'positional' as const, value: arg };
  });

  const spec = finish({
    type: 'package',
    runtime: parsed.runtime,
    identifier: parsed.identifier,
    version,
    ...(packageArguments.length > 0 ? { packageArguments } : {}),
    ...(environmentVariables.length > 0 ? { environmentVariables } : {}),
    auth: fields.length > 0 ? { mode: 'userSecret', fields, inject } : { mode: 'none' },
  });
  return {
    name: typeof record.__name === 'string' ? record.__name : parsed.identifier,
    source: 'client-config',
    spec,
    warnings,
  };
};

// --- server.json ----------------------------------------------------------------------------------------------------

export type ImportedServerJson = {
  serverJson: ServerJson;
  mapping: MappingResult;
};

/** Parses pasted `server.json` text or an object and maps it (11.3, 11.6). */
export const importFromServerJson = (
  input: unknown,
  options: { prefer?: Prefer } = {},
): ImportedServerJson => {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new RegistryMappingError('server.json is not valid JSON', { cause: error });
    }
  }
  // Registry responses wrap the document as `{ server, _meta }`; accept both.
  if (typeof value === 'object' && value !== null && 'server' in value && !('name' in value)) {
    value = (value as { server: unknown }).server;
  }
  const parsed = serverJsonSchema.safeParse(value);
  if (!parsed.success) {
    throw new RegistryMappingError(
      `server.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { cause: parsed.error },
    );
  }
  return {
    serverJson: parsed.data,
    mapping: serverJsonToSpec(parsed.data, options.prefer ? { prefer: options.prefer } : {}),
  };
};

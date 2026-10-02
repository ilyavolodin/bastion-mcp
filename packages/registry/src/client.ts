import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAddressDenied, normalizeIpLiteral } from '@bastion-mcp/core';
import {
  RegistryInvalidResponseError,
  RegistryNotFoundError,
  RegistryUnavailableError,
  RegistryUrlDeniedError,
} from './errors';
import type { FetchFn, RegistrySource, SecretResolver } from './ports';
import {
  encodeRegistryName,
  listEnvelopeSchema,
  parseRegistryEntry,
  type RegistryEntry,
} from './server-json';

/** MCP Registry REST API v0.1 client (11.6). */

export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 32 * 1024 * 1024;
const MAX_PAGES = 5_000;

// --- Base URL guard (8.8, 11.6) ------------------------------------------------------------------------------------

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export type BaseUrlPolicy = {
  /** Private ranges an admin explicitly allows for self-hosted subregistries (`allowCidrs` of 8.8). */
  allowCidrs?: readonly string[];
  clusterCidrs?: readonly string[];
  resolveHost?: ResolveHost;
};

/**
 * Validates a registry base URL when a source is created or edited. Requires https (http only to an allowed
 * private range), refuses credentials in the URL and every host that resolves to a denied address.
 * Returns the normalized URL without a trailing slash. DNS rebinding after this check is stopped by the
 * egress layer, not here.
 */
export const assertRegistryBaseUrl = async (
  raw: string,
  policy: BaseUrlPolicy = {},
): Promise<string> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RegistryUrlDeniedError('registry base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RegistryUrlDeniedError('registry base URL must use https');
  }
  if (url.username || url.password) {
    throw new RegistryUrlDeniedError('registry base URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new RegistryUrlDeniedError('registry base URL must not contain a query or fragment');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host) ? host : normalizeIpLiteral(host);
  const addresses = literal ? [literal] : await (policy.resolveHost ?? defaultResolveHost)(host);
  if (addresses.length === 0) throw new RegistryUrlDeniedError('registry host does not resolve');
  const addressPolicy = {
    ...(policy.allowCidrs ? { allowCidrs: policy.allowCidrs } : {}),
    ...(policy.clusterCidrs ? { clusterCidrs: policy.clusterCidrs } : {}),
  };
  const denied = addresses.find((a) => isAddressDenied(a, addressPolicy));
  if (denied)
    throw new RegistryUrlDeniedError(`registry host resolves to a denied address (${denied})`);
  const isPublic = addresses.every((a) => !isAddressDenied(a, {}));
  if (url.protocol === 'http:' && isPublic) {
    throw new RegistryUrlDeniedError('registry base URL must use https');
  }
  return url.toString().replace(/\/+$/, '');
};

// --- Client ---------------------------------------------------------------------------------------------------------

export type RegistryClientOptions = {
  baseUrl: string;
  /** Extra header sent with every call, for example `{ name: 'Authorization', value: 'Bearer ...' }`. */
  authHeader?: { name: string; value: string };
  fetch?: FetchFn;
  timeoutMs?: number;
  userAgent?: string;
};

export type ListServersOptions = {
  limit?: number;
  updatedSince?: Date | string | undefined;
  cursor?: string | undefined;
  search?: string;
  signal?: AbortSignal;
};

export type ServersPage = {
  entries: RegistryEntry[];
  /** List elements that failed validation and were skipped. */
  invalid: number;
  nextCursor?: string;
};

export type RegistryClient = {
  /** One page; `nextCursor` is undefined on the last page. */
  listServersPage(options?: ListServersOptions): Promise<ServersPage>;
  /** Follows `metadata.nextCursor` until the registry stops sending one. */
  listServers(options?: ListServersOptions): AsyncGenerator<ServersPage, void, undefined>;
  getVersions(name: string, options?: { signal?: AbortSignal }): Promise<RegistryEntry[]>;
  getVersion(
    name: string,
    version: string,
    options?: { signal?: AbortSignal },
  ): Promise<RegistryEntry>;
};

export const createRegistryClient = (options: RegistryClientOptions): RegistryClient => {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const getJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': options.userAgent ?? 'bastion-mcp-registry-sync',
    };
    if (options.authHeader) headers[options.authHeader.name] = options.authHeader.value;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method: 'GET',
        headers,
        // A redirect could lead to an internal address that the base-URL guard never saw.
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      throw new RegistryUnavailableError('registry request failed', { cause: error });
    }
    if (response.status === 404) throw new RegistryNotFoundError(`registry has no ${path}`);
    if (!response.ok) {
      throw new RegistryUnavailableError(`registry answered HTTP ${response.status}`, {
        data: { status: response.status },
      });
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new RegistryUnavailableError('registry response could not be read', { cause: error });
    }
    if (text.length > MAX_BODY_CHARS)
      throw new RegistryInvalidResponseError('registry response too large');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new RegistryInvalidResponseError('registry answered invalid JSON', { cause: error });
    }
  };

  const parseList = (body: unknown): ServersPage => {
    const envelope = listEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new RegistryInvalidResponseError(
        'registry list response does not match the v0.1 schema',
        {
          cause: envelope.error,
        },
      );
    }
    const entries: RegistryEntry[] = [];
    let invalid = 0;
    for (const raw of envelope.data.servers) {
      try {
        entries.push(parseRegistryEntry(raw));
      } catch {
        invalid += 1;
      }
    }
    const next = envelope.data.metadata?.nextCursor;
    return { entries, invalid, ...(next ? { nextCursor: next } : {}) };
  };

  const listServersPage = async (opts: ListServersOptions = {}): Promise<ServersPage> => {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? DEFAULT_PAGE_SIZE));
    if (opts.updatedSince) {
      const since =
        opts.updatedSince instanceof Date ? opts.updatedSince.toISOString() : opts.updatedSince;
      params.set('updated_since', since);
    }
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.search) params.set('search', opts.search);
    return parseList(await getJson(`/v0.1/servers?${params.toString()}`, opts.signal));
  };

  async function* listServers(
    opts: ListServersOptions = {},
  ): AsyncGenerator<ServersPage, void, undefined> {
    let cursor = opts.cursor;
    const seen = new Set<string>();
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = await listServersPage({ ...opts, cursor });
      yield page;
      if (!page.nextCursor) return;
      if (seen.has(page.nextCursor)) {
        throw new RegistryInvalidResponseError('registry returned a repeating cursor');
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new RegistryInvalidResponseError('registry returned too many pages');
  }

  return {
    listServersPage,
    listServers,
    async getVersions(name, opts) {
      const body = await getJson(
        `/v0.1/servers/${encodeRegistryName(name)}/versions`,
        opts?.signal,
      );
      return parseList(body).entries;
    },
    async getVersion(name, version, opts) {
      const body = await getJson(
        `/v0.1/servers/${encodeRegistryName(name)}/versions/${encodeURIComponent(version)}`,
        opts?.signal,
      );
      try {
        return parseRegistryEntry(body);
      } catch (error) {
        throw new RegistryInvalidResponseError(
          'registry version response does not match the schema',
          {
            cause: error,
          },
        );
      }
    },
  };
};

/** Builds a client for a stored source, resolving its auth header secret through the port. */
export const createClientForSource = async (
  source: Pick<RegistrySource, 'baseUrl' | 'authSecretId' | 'authHeaderName'>,
  deps: { secrets: SecretResolver; fetch?: FetchFn; timeoutMs?: number },
): Promise<RegistryClient> => {
  let authHeader: RegistryClientOptions['authHeader'];
  if (source.authSecretId) {
    const secret = await deps.secrets.resolve(source.authSecretId);
    if (secret === undefined) throw new RegistryUnavailableError('registry auth secret is missing');
    const name = source.authHeaderName ?? 'Authorization';
    const needsScheme = name.toLowerCase() === 'authorization' && !/\s/.test(secret);
    authHeader = { name, value: needsScheme ? `Bearer ${secret}` : secret };
  }
  return createRegistryClient({
    baseUrl: source.baseUrl,
    ...(authHeader ? { authHeader } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });
};

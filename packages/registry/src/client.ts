import {
  isAddressDenied,
  resolveAndCheckUrl,
  UrlCheckError,
  type UrlCheckReason,
} from '@bastion-mcp/core';
import { MAX_BODY_BYTES, readBodyCapped } from './body';
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
export const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_PAGES = 5_000;

// --- Base URL guard (8.8, 11.6) ------------------------------------------------------------------------------------

export type ResolveHost = (host: string) => Promise<string[]>;

export type BaseUrlPolicy = {
  /** Private ranges an admin explicitly allows for self-hosted subregistries (`allowCidrs` of 8.8). */
  allowCidrs?: readonly string[];
  clusterCidrs?: readonly string[];
  resolveHost?: ResolveHost;
};

const DENIED_MESSAGES: Record<UrlCheckReason, string> = {
  'invalid-url': 'registry base URL is not a valid URL',
  scheme: 'registry base URL must use https',
  credentials: 'registry base URL must not contain credentials',
  insecure: 'registry base URL must use https',
  unresolvable: 'registry host does not resolve',
  'blocked-address': 'registry host resolves to a denied address',
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
  try {
    const { url } = await resolveAndCheckUrl(raw, {
      addressPolicy: {
        ...(policy.allowCidrs ? { allowCidrs: policy.allowCidrs } : {}),
        ...(policy.clusterCidrs ? { clusterCidrs: policy.clusterCidrs } : {}),
      },
      ...(policy.resolveHost ? { lookup: policy.resolveHost } : {}),
      allowHttpAddresses: (addresses) => addresses.every((a) => isAddressDenied(a, {})),
    });
    if (url.search || url.hash) {
      throw new RegistryUrlDeniedError('registry base URL must not contain a query or fragment');
    }
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    if (!(error instanceof UrlCheckError)) throw error;
    // The thrown RegistryUrlDeniedError for query/fragment is raised in the try and passes through above.
    const detail = error.reason === 'blocked-address' ? ` (${error.detail?.address})` : '';
    throw new RegistryUrlDeniedError(`${DENIED_MESSAGES[error.reason]}${detail}`);
  }
};

// --- Client ---------------------------------------------------------------------------------------------------------

export type RegistryClientOptions = {
  baseUrl: string;
  /** Extra header sent with every call, for example `{ name: 'Authorization', value: 'Bearer ...' }`. */
  authHeader?: { name: string; value: string };
  fetch?: FetchFn;
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Extra attempts for a page that timed out, was refused (429) or failed with a 5xx (default 0). The real registry
   * stalls now and then; a sync of thousands of entries must not die on one slow page.
   */
  retries?: number;
  retryDelayMs?: number;
  /** Largest response body accepted, in bytes (default 32 MiB). */
  maxBodyBytes?: number;
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
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const getJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await getJsonOnce(path, signal);
      } catch (error) {
        const status = (error as { data?: { status?: number } }).data?.status;
        const transient =
          error instanceof RegistryUnavailableError &&
          (status === undefined || status === 429 || status >= 500);
        if (!transient || attempt >= retries || signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      }
    }
  };

  const getJsonOnce = async (path: string, signal?: AbortSignal): Promise<unknown> => {
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
      text = await readBodyCapped(response, maxBodyBytes);
    } catch (error) {
      if (error instanceof RegistryInvalidResponseError) throw error;
      throw new RegistryUnavailableError('registry response could not be read', { cause: error });
    }
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
  deps: {
    secrets: SecretResolver;
    fetch?: FetchFn;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  },
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
    ...(deps.retries ? { retries: deps.retries } : {}),
    ...(deps.retryDelayMs ? { retryDelayMs: deps.retryDelayMs } : {}),
  });
};

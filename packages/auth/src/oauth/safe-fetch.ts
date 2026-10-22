import {
  type AddressPolicy,
  BastionError,
  isAddressDenied,
  pinnedLookup,
  resolveAndCheckUrl,
  UrlCheckError,
} from '@bastion-mcp/core';
import { Agent, type Dispatcher } from 'undici';
import { MAX_PINNED_AGENTS, OAUTH_TIMEOUTS_MS } from './constants';
import type { FetchFn } from './ports';

/** SSRF guard for every discovery, registration and token endpoint call (9.6, 23.3). */
export class OutboundDeniedError extends BastionError {
  constructor(message: string) {
    super('OUTBOUND_DENIED', message, { httpStatus: 403 });
  }
}

export type OutboundPolicy = {
  addressPolicy?: AddressPolicy;
  /** Resolves a hostname to every address; defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Permit plain http only when the target address is inside an admin-allowed CIDR. Default false. */
  allowHttpToAllowedCidrs?: boolean;
  /** `BASTION_INSECURE_UPSTREAM_HOSTS`: hosts (or host:port) the administrator allows over plain http. */
  allowHttpHosts?: readonly string[];
  timeoutMs?: number;
};

export type OutboundTarget = { url: URL; address: string; family: 4 | 6 };

/**
 * Validates the URL and resolves its host ONCE; the caller must connect to the returned address (8.8, 8.9).
 * Throws OutboundDeniedError unless the URL is https (or http to an admin-allowed address) and public.
 */
export const resolveOutboundTarget = async (
  raw: string,
  policy: OutboundPolicy = {},
): Promise<OutboundTarget> => {
  try {
    const checked = await resolveAndCheckUrl(raw, {
      ...(policy.addressPolicy ? { addressPolicy: policy.addressPolicy } : {}),
      ...(policy.lookup ? { lookup: policy.lookup } : {}),
      // Plain http is only for targets inside an admin-allowed CIDR, and only when the caller opted in.
      allowHttp: (url, hostname) => {
        const hosts = (policy.allowHttpHosts ?? []).map((h) => h.toLowerCase());
        return hosts.includes(hostname.toLowerCase()) || hosts.includes(url.host.toLowerCase());
      },
      allowHttpAddresses: (addresses) =>
        policy.allowHttpToAllowedCidrs === true &&
        addresses.every((address) => isAddressDenied(address, {})),
    });
    return { url: checked.url, address: checked.address, family: checked.family };
  } catch (error) {
    if (!(error instanceof UrlCheckError)) throw error;
    throw new OutboundDeniedError(
      error.reason === 'scheme' ? 'only http(s) URLs are allowed' : error.message,
    );
  }
};

/** Throws OutboundDeniedError unless the URL is https (or http to an admin-allowed address) and public. */
export const assertOutboundUrl = async (raw: string, policy: OutboundPolicy = {}): Promise<URL> =>
  (await resolveOutboundTarget(raw, policy)).url;

/** Keep-alive dispatchers, one per validated address; each connection can only reach that address. */
export type PinnedDispatcherPool = {
  get(target: OutboundTarget): Dispatcher;
  /** Closes every dispatcher (shutdown and tests). */
  close(): Promise<void>;
};

export const createPinnedDispatcherPool = (): PinnedDispatcherPool => {
  const agents = new Map<string, Agent>();
  return {
    get(target) {
      const existing = agents.get(target.address);
      if (existing) return existing;
      if (agents.size >= MAX_PINNED_AGENTS) {
        const oldest = agents.keys().next();
        if (!oldest.done) {
          void agents
            .get(oldest.value)
            ?.close()
            .catch(() => undefined);
          agents.delete(oldest.value);
        }
      }
      const agent = new Agent({
        keepAliveTimeout: OAUTH_TIMEOUTS_MS.keepAlive,
        connect: { lookup: pinnedLookup(target), timeout: OAUTH_TIMEOUTS_MS.connect },
      });
      agents.set(target.address, agent);
      return agent;
    },
    async close() {
      const open = [...agents.values()];
      agents.clear();
      await Promise.all(open.map((agent) => agent.close().catch(() => undefined)));
    },
  };
};

/** Wraps a fetch: checks the URL, pins the connection to the checked address, never follows redirects, applies a timeout. */
export const createSafeFetch = (
  inner: FetchFn,
  policy: OutboundPolicy = {},
  pool: PinnedDispatcherPool = createPinnedDispatcherPool(),
): FetchFn => {
  const safe = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const resolved = await resolveOutboundTarget(target, policy);
    const signals: AbortSignal[] = [
      AbortSignal.timeout(policy.timeoutMs ?? OAUTH_TIMEOUTS_MS.request),
    ];
    if (init?.signal) signals.push(init.signal);
    return inner(input, {
      ...init,
      dispatcher: pool.get(resolved),
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    } as unknown as RequestInit);
  };
  return safe as FetchFn;
};
